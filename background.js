const MODEL_PRIORITY = [
  "gemini-3.5-flash-lite",
  "gemini-3.6-flash",
  "gemini-3.1-flash-lite"
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type !== "SOLVE_QUESTION") {
    return false;
  }

  // Keep the MV3 service worker awake while waiting on network calls
  const keepAlive = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => {});
  }, 20000);

  (async () => {
    try {
      const selectedId = await solveWithGemini(request.payload);
      sendResponse({ success: true, selectedId });
    } catch (error) {
      sendResponse({
        success: false,
        status: error.status || 500,
        error: error.message || "Unknown background error"
      });
    } finally {
      clearInterval(keepAlive);
    }
  })();

  return true;
});

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchImagePart(url) {
  const response = await fetchWithTimeout(url, {}, 8000);
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
              selectedId: {
                type: "STRING",
                description: "The exact ID string of the correct answer choice."
              }
            },
            required: ["selectedId"]
          }
        }
      })
    },
    12000
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
    err.status = 503; // Treat empty/blocked response as transient so fallback model runs
    throw err;
  }

  const parsed = JSON.parse(rawJson);
  if (!parsed?.selectedId) {
    throw new Error(`Model ${model} returned malformed JSON: ${rawJson}`);
  }

  return parsed.selectedId;
}

async function solveWithGemini({ questionText, imageUrls, choices }) {
  const { geminiApiKey } = await chrome.storage.local.get("geminiApiKey");
  if (!geminiApiKey) {
    throw new Error("Missing Gemini API key. Set it in the extension popup.");
  }

  const formattedChoices = choices
    .map((c) => `- ID: "${c.id}" | Option: ${c.text}`)
    .join("\n");

  const prompt = [
    "Analyze the passage, question, and any attached images, then choose the single best answer.",
    "",
    "QUESTION & PASSAGE:",
    questionText,
    "",
    "ANSWER CHOICES:",
    formattedChoices
  ].join("\n");

  const parts = [{ text: prompt }];

  for (const url of imageUrls) {
    try {
      const imagePart = await fetchImagePart(url);
      parts.push(imagePart);
    } catch (err) {
      console.warn("Skipping unreadable image:", url, err);
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
        await sleep(1000);
        continue;
      }
      throw err;
    }
  }

  throw lastError;
}