const MODEL_PRIORITY = [
  "gemini-3.5-flash-lite",
  "gemini-3.8-flash",
  "gemini-3.6-flash"
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

chrome.runtime.onConnect.addListener((port) => {
  // Keep-alive port held by the content script so Chrome doesn't freeze background tabs
  if (port.name === "TAB_KEEP_ALIVE") {
    let disconnected = false;
    const timer = setInterval(() => {
      if (!disconnected) {
        try {
          port.postMessage({ type: "PONG" });
        } catch {}
      }
      chrome.runtime.getPlatformInfo(() => {});
    }, 5000);

    port.onDisconnect.addListener(() => {
      disconnected = true;
      clearInterval(timer);
    });

    port.onMessage.addListener((msg) => {
      if (msg.type === "PING" && !disconnected) {
        try {
          port.postMessage({ type: "PONG" });
        } catch {}
      }
    });
    return;
  }

  if (port.name !== "SOLVE_BATCH_PORT") return;

  let disconnected = false;

  const keepAlive = setInterval(() => {
    if (!disconnected) {
      try {
        port.postMessage({ type: "PONG" });
      } catch {}
    }
    chrome.runtime.getPlatformInfo(() => {});
  }, 4000);

  port.onDisconnect.addListener(() => {
    disconnected = true;
    clearInterval(keepAlive);
  });

  port.onMessage.addListener(async (msg) => {
    if (msg.type === "PING") {
      if (!disconnected) {
        try {
          port.postMessage({ type: "PONG" });
        } catch {}
      }
      return;
    }

    if (msg.type !== "SOLVE_BATCH") return;

    try {
      const answers = await solveBatchWithGemini(msg.payload);
      if (!disconnected) {
        port.postMessage({ type: "RESULT", success: true, answers });
      }
    } catch (error) {
      if (!disconnected) {
        port.postMessage({
          type: "RESULT",
          success: false,
          status: error.status || 500,
          error: error.message || "Unknown background error"
        });
      }
    }
  });
});

async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function parseDataUrl(dataUrl) {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) return null;
  return {
    inlineData: {
      mimeType: match[1],
      data: match[2]
    }
  };
}

async function fetchImagePart(imageEntry) {
  if (typeof imageEntry === "string" && imageEntry.startsWith("data:")) {
    return parseDataUrl(imageEntry);
  }

  const response = await fetchWithTimeout(imageEntry, {}, 6000);
  if (!response.ok) throw new Error(`Failed to fetch image: ${response.status}`);

  const blob = await response.blob();
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }

  return {
    inlineData: {
      mimeType: blob.type || "image/png",
      data: btoa(binary)
    }
  };
}

async function callModel(model, apiKey, parts) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const res = await fetchWithTimeout(
    endpoint,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          thinkingConfig: { thinkingLevel: "LOW" },
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              answers: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: {
                    k: { type: "STRING" },
                    reasoning: {
                      type: "STRING",
                      description: "Ultra-brief 5-12 word verification of the fact or math before selecting."
                    },
                    ids: {
                      type: "ARRAY",
                      items: { type: "STRING" },
                      description: "1 ID for SINGLE-CHOICE, all matching IDs for MULTI-SELECT, or [] otherwise."
                    },
                    textAnswers: {
                      type: "ARRAY",
                      description: "Values for each [BLANK id=...] in FILL-IN-THE-BLANK, or [] otherwise.",
                      items: {
                        type: "OBJECT",
                        properties: {
                          id: { type: "STRING" },
                          value: { type: "STRING" }
                        },
                        required: ["id", "value"]
                      }
                    },
                    dropdownAnswers: {
                      type: "ARRAY",
                      description: "Option 'value' for each [DROPDOWN id=...] in DROPDOWN, or [] otherwise.",
                      items: {
                        type: "OBJECT",
                        properties: {
                          selectId: { type: "STRING" },
                          value: { type: "STRING" }
                        },
                        required: ["selectId", "value"]
                      }
                    }
                  },
                  required: ["k", "reasoning", "ids", "textAnswers", "dropdownAnswers"]
                }
              }
            },
            required: ["answers"]
          }
        }
      })
    },
    20000
  );

  if (!res.ok) {
    const errText = await res.text();
    const err = new Error(`Gemini API error (${res.status}) on ${model}: ${errText}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  const candidate = data.candidates?.[0];
  const rawJson = candidate?.content?.parts?.[0]?.text;

  if (!rawJson) {
    const reason = candidate?.finishReason || "EMPTY_RESPONSE";
    const err = new Error(`Model ${model} returned no text (reason: ${reason})`);
    err.status = 503;
    throw err;
  }

  const parsed = JSON.parse(rawJson);
  if (!Array.isArray(parsed?.answers)) {
    throw new Error(`Model ${model} returned malformed JSON: ${rawJson}`);
  }

  return parsed.answers;
}

async function solveBatchWithGemini(questions) {
  const { geminiApiKey } = await chrome.storage.local.get("geminiApiKey");
  if (!geminiApiKey) {
    throw new Error("Missing Gemini API key. Set it in the extension popup.");
  }

  const parts = [
    {
      text: [
        "Solve every question accurately using its passage, text, choices/blanks/dropdowns, and image(s).",
        "- Put a 5-12 word verification in 'reasoning' first.",
        "- SINGLE-CHOICE: 1 winning ID in 'ids'; [] in 'textAnswers' and 'dropdownAnswers'.",
        "- MULTI-SELECT: all requested winning IDs in 'ids'; [] in 'textAnswers' and 'dropdownAnswers'.",
        "- FILL-IN-THE-BLANK: [] in 'ids' and 'dropdownAnswers'; { id, value } for each [BLANK id=\"...\"] in 'textAnswers'.",
        "- DROPDOWN: [] in 'ids' and 'textAnswers'; { selectId, value } using exact option 'value' for each [DROPDOWN id=\"...\"] in 'dropdownAnswers'.",
        "Return ONLY the JSON object."
      ].join("\n")
    }
  ];

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const passageSection = q.passageText ? `PASSAGE:\n${q.passageText}\n\n` : "";

    if (q.questionType === "fill_in_the_blank") {
      parts.push({
        text: `\n--- Q${i + 1} [k="${q.questionKey}"] [FILL-IN-THE-BLANK] ---\n${passageSection}${q.questionText}`
      });
    } else if (q.questionType === "dropdown") {
      const formattedDropdowns = q.dropdowns
        .map((dd) => {
          const opts = dd.options
            .map((o) => `    value="${o.value}": ${o.text}`)
            .join("\n");
          return `  For selectId="${dd.selectId}":\n${opts}`;
        })
        .join("\n");

      parts.push({
        text: `\n--- Q${i + 1} [k="${q.questionKey}"] [DROPDOWN] ---\n${passageSection}${q.questionText}\nDROPDOWN OPTIONS:\n${formattedDropdowns}`
      });
    } else {
      const typeLabel =
        q.questionType === "multi_select"
          ? "MULTI-SELECT (select all requested options)"
          : "SINGLE-CHOICE (select 1 option)";

      const formattedChoices = q.choices
        .map((c) => `  id="${c.id}": ${c.text}`)
        .join("\n");

      parts.push({
        text: `\n--- Q${i + 1} [k="${q.questionKey}"] [${typeLabel}] ---\n${passageSection}${q.questionText}\nCHOICES:\n${formattedChoices}`
      });
    }

    if (q.images?.length) {
      const imageResults = await Promise.all(
        q.images.map((img) =>
          fetchImagePart(img).catch((err) => {
            console.warn("Skipping unreadable image:", err);
            return null;
          })
        )
      );
      for (const imgPart of imageResults) {
        if (imgPart) parts.push(imgPart);
      }
    }
  }

  let lastError;
  for (const model of MODEL_PRIORITY) {
    try {
      return await callModel(model, geminiApiKey, parts);
    } catch (err) {
      lastError = err;
      const isTimeout = err.name === "AbortError";
      if (isTimeout || err.status === 503 || err.status === 429) {
        console.warn(`${model} timed out or busy, trying next model...`);
        await sleep(600);
        continue;
      }
      throw err;
    }
  }

  throw lastError;
}
