(() => {
  if (typeof window.__edgenuityBotStop === "function") {
    try {
      window.__edgenuityBotStop();
    } catch {}
  }

  const SCRIPT_GENERATION = (window.__edgenuityBotGeneration || 0) + 1;
  window.__edgenuityBotGeneration = SCRIPT_GENERATION;

  let isRunning = false;
  const BATCH_SIZE = 4;
  const MAX_CONCURRENT_BATCHES = 2;
  const DEFAULT_MIN_DELAY_SEC = 60;
  const DEFAULT_MAX_DELAY_SEC = 120;

  window.__edgenuityBotStop = () => {
    isRunning = false;
  };

  function isContextValid() {
    return (
      window.__edgenuityBotGeneration === SCRIPT_GENERATION &&
      typeof chrome !== "undefined" &&
      Boolean(chrome.runtime?.id)
    );
  }

  const sleep = (ms) =>
    new Promise((resolve) => {
      const end = Date.now() + ms;
      const tick = () => {
        if (!isRunning || !isContextValid()) return resolve();
        const remaining = end - Date.now();
        if (remaining <= 0) return resolve();
        setTimeout(tick, Math.min(remaining, 500));
      };
      setTimeout(tick, Math.min(ms, 500));
    });

  const rawSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function startTabKeepAlive() {
    if (!isContextValid()) return () => {};
    let port = null;
    try {
      port = chrome.runtime.connect({ name: "TAB_KEEP_ALIVE" });
    } catch {
      return () => {};
    }

    const timer = setInterval(() => {
      if (!isContextValid()) {
        clearInterval(timer);
        return;
      }
      try {
        port.postMessage({ type: "PING" });
      } catch {}
    }, 5000);

    return () => {
      clearInterval(timer);
      try {
        port?.disconnect();
      } catch {}
    };
  }

  function chunkArray(arr, size) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }

  function normalizeDelayBounds(minDelaySec, maxDelaySec) {
    const min = Math.max(0, Number.isFinite(minDelaySec) ? minDelaySec : DEFAULT_MIN_DELAY_SEC);
    const max = Math.max(min, Number.isFinite(maxDelaySec) ? maxDelaySec : DEFAULT_MAX_DELAY_SEC);
    return { minDelaySec: min, maxDelaySec: max };
  }

  function setAutomationState(
    running,
    autoSubmit = false,
    minDelaySec = DEFAULT_MIN_DELAY_SEC,
    maxDelaySec = DEFAULT_MAX_DELAY_SEC
  ) {
    if (!isContextValid()) return Promise.resolve();
    const bounds = normalizeDelayBounds(minDelaySec, maxDelaySec);
    return chrome.storage.local
      .set({
        automationState: {
          isRunning: running,
          autoSubmit,
          minDelaySec: bounds.minDelaySec,
          maxDelaySec: bounds.maxDelaySec
        }
      })
      .catch(() => {});
  }

  function getActiveQuestionContainer() {
    const containers = document.querySelectorAll(
      ".question-container > .Assessment_Main_Body_Content_Question"
    );
    for (const el of containers) {
      if (el.style.display !== "none" && el.getClientRects().length > 0) {
        return el;
      }
    }
    return null;
  }

  function getActiveQuestionKey() {
    const active = getActiveQuestionContainer();
    return active?.querySelector("input.question-key")?.value || "";
  }

  function isElementVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      el.getClientRects().length > 0
    );
  }

  function isOuterNextButtonEnabled(btn) {
    if (!isElementVisible(btn)) return false;
    if (btn.disabled || btn.getAttribute("aria-disabled") === "true") return false;
    if (btn.classList.contains("disabled") || btn.classList.contains("ui-state-disabled")) {
      return false;
    }
    const style = window.getComputedStyle(btn);
    if (style.pointerEvents === "none") return false;
    return true;
  }

  async function clickOuterNextActivity(timeoutMs = 12000) {
    const start = Date.now();
    const activityName = document.getElementById("activity-title")?.innerText?.trim() || "";

    while (Date.now() - start < timeoutMs) {
      if (!isContextValid()) return false;

      const nextLink =
        document.querySelector(".mainfoot .footnav.goRight") ||
        Array.from(document.querySelectorAll(".mainfoot a")).find((a) =>
          /next activity/i.test(a.innerText)
        );

      if (nextLink && isOuterNextButtonEnabled(nextLink)) {
        await rawSleep(400);
        nextLink.click();
        console.log(
          `Clicked outer Next Activity button${activityName ? ` (after "${activityName}")` : ""}.`
        );
        return true;
      }

      await rawSleep(250);
    }

    console.warn("Outer Next Activity button was not available or remained disabled.");
    return false;
  }

  function getVisibleTextInputs(contents) {
    if (!contents) return [];
    return Array.from(
      contents.querySelectorAll('input[type="text"], input:not([type])')
    ).filter((el) => el.id && el.style.display !== "none");
  }

  function getVisibleSelects(contents) {
    if (!contents) return [];
    return Array.from(contents.querySelectorAll("select")).filter(
      (el) => el.id && el.style.display !== "none"
    );
  }

  function hasQuestionInputs(container) {
    const contents = container.querySelector(".Question_Contents");
    return (
      container.querySelectorAll(".answer-choice").length > 0 ||
      container.querySelectorAll("textarea").length > 0 ||
      getVisibleTextInputs(contents).length > 0 ||
      getVisibleSelects(contents).length > 0
    );
  }

  function setTextElementValue(el, value) {
    if (!el) return false;
    el.focus();
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
    return true;
  }

  function setSelectElementValue(selectId, optionValue) {
    const selectEl = document.getElementById(selectId);
    if (!selectEl) return false;

    const target = String(optionValue).trim();
    let matchedOption = Array.from(selectEl.options).find(
      (opt) => opt.value === target
    );

    if (!matchedOption) {
      matchedOption = Array.from(selectEl.options).find(
        (opt) =>
          opt.id === target ||
          opt.text.trim().toLowerCase() === target.toLowerCase()
      );
    }

    if (!matchedOption) return false;

    selectEl.focus();
    selectEl.value = matchedOption.value;
    matchedOption.selected = true;
    selectEl.dispatchEvent(new Event("input", { bubbles: true }));
    selectEl.dispatchEvent(new Event("change", { bubbles: true }));
    selectEl.dispatchEvent(new Event("blur", { bubbles: true }));
    return true;
  }

  function handleTextareas(activeContainer) {
    const contents = activeContainer.querySelector(".Question_Contents");
    if (!contents) return false;

    const textareas = Array.from(contents.querySelectorAll("textarea")).filter(
      (el) => el.style.display !== "none"
    );

    if (!textareas.length) return false;

    for (const textarea of textareas) {
      setTextElementValue(textarea, "No");
    }

    return true;
  }

  function extractPassageText() {
    const passageSelectors = [
      ".Assessment_Main_Body_Content_Passage",
      ".Reading_Passage",
      ".passage-container"
    ];
    for (const sel of passageSelectors) {
      const el = document.querySelector(sel);
      if (el && isElementVisible(el)) {
        const text = el.innerText.trim();
        if (text) return text;
      }
    }
    return "";
  }

  function serializeQuestionImages(contents) {
    const imgs = Array.from(contents.querySelectorAll("img")).filter(
      (img) => img.src && !img.src.startsWith("data:image/gif")
    );

    return imgs.map((img) => {
      try {
        if (!img.complete || img.naturalWidth === 0) return img.src;

        const maxDim = 768;
        let width = img.naturalWidth;
        let height = img.naturalHeight;

        if (width > maxDim || height > maxDim) {
          const scale = Math.min(maxDim / width, maxDim / height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);

        return canvas.toDataURL("image/jpeg", 0.8);
      } catch {
        return img.src;
      }
    });
  }

  function extractCleanQuestionText(contents, { replaceTextInputs = false, replaceSelects = false } = {}) {
    const clone = contents.cloneNode(true);

    clone.querySelectorAll(".answer-choice").forEach((el) => el.remove());

    clone.querySelectorAll("img").forEach((img) => {
      const alt = img.getAttribute("alt")?.trim();
      if (alt && !alt.toLowerCase().startsWith("image")) {
        img.replaceWith(document.createTextNode(` ${alt} `));
      }
    });

    if (replaceTextInputs) {
      const cloneInputs = clone.querySelectorAll('input[type="text"], input:not([type])');
      for (const input of cloneInputs) {
        if (input.id && input.style.display !== "none") {
          input.replaceWith(document.createTextNode(` [BLANK id="${input.id}"] `));
        }
      }
    }

    if (replaceSelects) {
      const cloneSelects = clone.querySelectorAll("select");
      for (const select of cloneSelects) {
        if (select.id && select.style.display !== "none") {
          select.replaceWith(document.createTextNode(` [DROPDOWN id="${select.id}"] `));
        }
      }
    }

    return clone.innerText
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function extractQuestionData(activeContainer) {
    const contents = activeContainer.querySelector(".Question_Contents");
    if (!contents) return null;

    const questionKey = activeContainer.querySelector("input.question-key")?.value || "";
    const passageText = extractPassageText();
    const images = serializeQuestionImages(contents);

    const selects = getVisibleSelects(contents);
    if (selects.length > 0) {
      const dropdowns = selects.map((selectEl) => {
        const options = Array.from(selectEl.querySelectorAll("option"))
          .filter((opt) => opt.value !== "" && opt.innerText.trim() !== "")
          .map((opt) => ({
            id: opt.id || "",
            value: opt.value,
            text: opt.innerText.trim()
          }));
        return {
          selectId: selectEl.id,
          options
        };
      });

      return {
        questionKey,
        questionType: "dropdown",
        passageText,
        questionText: extractCleanQuestionText(contents, { replaceSelects: true }),
        images,
        dropdowns,
        textInputs: [],
        choices: []
      };
    }

    const textInputs = getVisibleTextInputs(contents);
    if (textInputs.length > 0) {
      return {
        questionKey,
        questionType: "fill_in_the_blank",
        passageText,
        questionText: extractCleanQuestionText(contents, { replaceTextInputs: true }),
        images,
        dropdowns: [],
        textInputs: textInputs.map((el) => ({ id: el.id })),
        choices: []
      };
    }

    const choices = Array.from(contents.querySelectorAll(".answer-choice"))
      .map((choiceEl) => {
        const input = choiceEl.querySelector("input.answer-choice-button");
        const label = choiceEl.querySelector("label.answer-choice-label");
        return {
          id: input ? input.id : "",
          type: input ? input.type : "radio",
          text: label ? label.innerText.trim() : ""
        };
      })
      .filter((c) => c.id && c.text);

    if (!choices.length) return null;

    const isMultiSelect = choices.some((c) => c.type === "checkbox");

    return {
      questionKey,
      questionType: isMultiSelect ? "multi_select" : "single_choice",
      passageText,
      questionText: extractCleanQuestionText(contents),
      images,
      dropdowns: [],
      textInputs: [],
      choices
    };
  }

  function setInputCheckedState(inputId, shouldCheck) {
    const input = document.getElementById(inputId);
    if (!input) return false;

    if (input.checked !== shouldCheck) {
      input.click();
      if (input.checked !== shouldCheck) {
        input.checked = shouldCheck;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }

    return true;
  }

  async function applyQuestionAnswers(question, answerObj) {
    if (!question || !answerObj || !isContextValid()) return;

    if (question.questionType === "dropdown") {
      const entries = Array.isArray(answerObj.dropdownAnswers) ? answerObj.dropdownAnswers : [];
      for (const entry of entries) {
        const ok = setSelectElementValue(entry.selectId, entry.value);
        if (!ok) {
          console.warn(`Dropdown selection failed for ${entry.selectId}:`, entry.value);
        }
        await sleep(160);
      }
      return;
    }

    if (question.questionType === "fill_in_the_blank") {
      const entries = Array.isArray(answerObj.textAnswers) ? answerObj.textAnswers : [];
      for (const entry of entries) {
        const input = document.getElementById(entry.id);
        if (!input) {
          console.warn("Text input ID not found:", entry.id);
          continue;
        }
        setTextElementValue(input, entry.value);
        await sleep(160);
      }
      return;
    }

    const ids = Array.isArray(answerObj.ids) ? answerObj.ids : [];
    const selectedSet = new Set(ids);

    if (question.questionType === "multi_select") {
      for (const choice of question.choices) {
        const shouldCheck = selectedSet.has(choice.id);
        const input = document.getElementById(choice.id);
        if (!input) continue;

        if (input.checked !== shouldCheck) {
          setInputCheckedState(choice.id, shouldCheck);
          await sleep(160);
        }
      }
    } else {
      const targetId = ids[0];
      if (!targetId) return;
      const ok = setInputCheckedState(targetId, true);
      if (!ok) {
        console.warn("Choice ID not found:", targetId);
      }
      await sleep(180);
    }
  }

  async function prepareAssessmentScreen(timeoutMs = 15000) {
    const start = Date.now();
    let clickedBegin = false;

    while (Date.now() - start < timeoutMs) {
      if (!isRunning || !isContextValid()) return "STOPPED";

      const alertBox = document.querySelector(".overlay-pretest-alert");
      if (isElementVisible(alertBox)) {
        const nextActivityLink = alertBox.querySelector("a");
        if (nextActivityLink) {
          await sleep(350);
          nextActivityLink.click();
          return "TRANSITIONING";
        }
      }

      const beginBtn = document.querySelector("button.overlay-attempt-clickable");
      if (isElementVisible(beginBtn) && !clickedBegin) {
        await sleep(350);
        beginBtn.click();
        clickedBegin = true;
      }

      const active = getActiveQuestionContainer();
      if (active && !isElementVisible(alertBox) && !isElementVisible(beginBtn)) {
        const currentKey = active.querySelector("input.question-key")?.value || "";
        if (currentKey && hasQuestionInputs(active)) {
          return "READY";
        }
      }

      await sleep(220);
    }

    return "TIMEOUT";
  }

  async function waitForActiveQuestion(excludeKey = null, timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (!isRunning || !isContextValid()) return false;
      const active = getActiveQuestionContainer();
      if (active) {
        const currentKey = active.querySelector("input.question-key")?.value || "";
        const alertVisible = isElementVisible(document.querySelector(".overlay-pretest-alert"));

        if (
          currentKey &&
          hasQuestionInputs(active) &&
          !alertVisible &&
          (!excludeKey || currentKey !== excludeKey)
        ) {
          return true;
        }
      }
      await sleep(140);
    }
    return false;
  }

  async function waitForAndConfirmSubmit(timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (!isRunning || !isContextValid()) return false;
      const modal = document.getElementById("submitConfirmMessage");
      if (isElementVisible(modal)) {
        const okBtn = modal.querySelector(".buttons .submit, .submit");
        if (okBtn) {
          await sleep(200);
          okBtn.click();
          console.log("Clicked OK on submit confirmation modal.");
          return true;
        }
      }
      await sleep(140);
    }
    return false;
  }

  async function waitForAndClickNextActivity(timeoutMs = 6000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (!isRunning || !isContextValid()) return false;
      const alertBox = document.querySelector(".overlay-pretest-alert");
      if (isElementVisible(alertBox)) {
        const nextActivityLink = alertBox.querySelector("a");
        if (nextActivityLink) {
          await sleep(350);
          nextActivityLink.click();
          return true;
        }
      }
      await sleep(220);
    }
    return false;
  }

  function sendViaPort(questions, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      if (!isContextValid()) {
        reject(new Error("Extension context invalidated. Refresh the page."));
        return;
      }

      let settled = false;
      let port;

      try {
        port = chrome.runtime.connect({ name: "SOLVE_BATCH_PORT" });
      } catch (err) {
        reject(err);
        return;
      }

      const cleanup = () => {
        clearInterval(pingTimer);
        clearTimeout(timeoutTimer);
        try {
          port.disconnect();
        } catch {}
      };

      const pingTimer = setInterval(() => {
        if (!isContextValid()) {
          if (!settled) {
            settled = true;
            cleanup();
            reject(new Error("Extension context invalidated. Refresh the page."));
          }
          return;
        }
        try {
          port.postMessage({ type: "PING" });
        } catch {}
      }, 4000);

      const timeoutTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error("Batch request timed out waiting for background worker."));
      }, timeoutMs);

      port.onMessage.addListener((response) => {
        if (response?.type === "PONG") return;
        if (settled) return;
        settled = true;
        cleanup();
        resolve(response);
      });

      port.onDisconnect.addListener(() => {
        if (settled) return;
        settled = true;
        cleanup();
        const reason = chrome.runtime.lastError?.message || "Port disconnected before response.";
        reject(new Error(reason));
      });

      setTimeout(() => {
        if (settled) return;
        try {
          port.postMessage({
            type: "SOLVE_BATCH",
            payload: questions
          });
        } catch (err) {
          if (!settled) {
            settled = true;
            cleanup();
            reject(err);
          }
        }
      }, 50);
    });
  }

  async function sendBatchRequest(questions, maxRetries = 3) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (!isRunning || !isContextValid()) {
        return { success: false, error: "Stopped or extension context invalidated." };
      }

      try {
        const response = await sendViaPort(questions);

        if (response?.success) {
          return response;
        }

        if ((response?.status === 429 || response?.status === 503) && attempt < maxRetries - 1) {
          await sleep(2500);
          continue;
        }

        return response || { success: false, error: "No response from background worker." };
      } catch (err) {
        console.warn(`Port interrupted (attempt ${attempt + 1}/${maxRetries}):`, err.message);

        if (!isContextValid() || err.message.includes("Extension context invalidated")) {
          return { success: false, error: "Extension context invalidated. Refresh the page." };
        }

        if (attempt < maxRetries - 1) {
          await sleep(1000);
          continue;
        }
        return { success: false, error: err.message };
      }
    }
  }

  async function collectAllQuestions() {
    const visitedKeys = new Set();
    const orderedKeys = [];
    const questionsMap = new Map();

    while (isRunning && isContextValid()) {
      const activeContainer = getActiveQuestionContainer();
      if (!activeContainer) break;

      const currentKey = activeContainer.querySelector("input.question-key")?.value || "";
      if (!currentKey) break;

      if (visitedKeys.has(currentKey)) {
        console.log(`Wrapped back to start (${currentKey}). Collection complete.`);
        break;
      }

      visitedKeys.add(currentKey);
      orderedKeys.push(currentKey);

      if (handleTextareas(activeContainer)) {
        console.log("Textarea detected; typed 'No' locally and skipped AI.");
        await sleep(180);
      } else {
        const payload = extractQuestionData(activeContainer);
        if (!payload) {
          console.warn("Unsupported question type encountered; stopping collection.");
          return null;
        }
        questionsMap.set(currentKey, payload);
      }

      const nextBtn = document.getElementById("nextQuestion");
      if (!isElementVisible(nextBtn)) {
        break;
      }

      nextBtn.click();
      let loaded = await waitForActiveQuestion(currentKey, 1800);

      if (!loaded && questionsMap.has(currentKey)) {
        const q = questionsMap.get(currentKey);
        if (q.questionType === "dropdown" && q.dropdowns.length > 0) {
          for (const dd of q.dropdowns) {
            if (dd.options.length > 0) {
              setSelectElementValue(dd.selectId, dd.options[0].value);
            }
          }
          await sleep(220);
          nextBtn.click();
          loaded = await waitForActiveQuestion(currentKey, 5000);
        } else if (q.questionType === "fill_in_the_blank" && q.textInputs.length > 0) {
          for (const blank of q.textInputs) {
            setTextElementValue(document.getElementById(blank.id), "a");
          }
          await sleep(220);
          nextBtn.click();
          loaded = await waitForActiveQuestion(currentKey, 5000);
        } else if (q.choices.length > 0) {
          setInputCheckedState(q.choices[0].id, true);
          await sleep(220);
          nextBtn.click();
          loaded = await waitForActiveQuestion(currentKey, 5000);
        }
      }

      if (!loaded) {
        console.log("Reached final question (next button did not advance).");
        break;
      }

      await sleep(130);
    }

    return { orderedKeys, questionsMap };
  }

  async function ensureAtFirstQuestion(firstKey) {
    if (!firstKey || getActiveQuestionKey() === firstKey) return true;

    const prevBtn = document.querySelector("#prevQuestion, #previousQuestion, .uibtn-arrow-prev");
    if (isElementVisible(prevBtn)) {
      for (let i = 0; i < 50; i++) {
        if (!isRunning || !isContextValid()) return false;
        const current = getActiveQuestionKey();
        if (current === firstKey) return true;
        prevBtn.click();
        await waitForActiveQuestion(current, 3000);
        await sleep(130);
      }
    }

    return getActiveQuestionKey() === firstKey;
  }

  async function solveBatchesConcurrently(batches) {
    const allAnswers = [];

    for (let i = 0; i < batches.length; i += MAX_CONCURRENT_BATCHES) {
      if (!isRunning || !isContextValid()) return null;

      const wave = batches.slice(i, i + MAX_CONCURRENT_BATCHES);
      console.log(
        `Waiting on Q1 while solving batch(es) ${i + 1}–${i + wave.length} of ${batches.length}...`
      );

      const results = await Promise.all(wave.map((batch) => sendBatchRequest(batch)));

      for (let j = 0; j < results.length; j++) {
        const res = results[j];
        if (!res || !res.success) {
          console.error(`Batch ${i + j + 1} failed:`, res?.error);
          return null;
        }
        allAnswers.push(...res.answers);
      }
    }

    return allAnswers;
  }

  async function runAutomation(
    autoSubmit,
    minDelaySec = DEFAULT_MIN_DELAY_SEC,
    maxDelaySec = DEFAULT_MAX_DELAY_SEC
  ) {
    if (isRunning || !isContextValid()) return;
    isRunning = true;
    let transitioningToNextActivity = false;
    const stopTabKeepAlive = startTabKeepAlive();
    const { minDelaySec: minSec, maxDelaySec: maxSec } = normalizeDelayBounds(
      minDelaySec,
      maxDelaySec
    );

    try {
      const prepStatus = await prepareAssessmentScreen(15000);

      if (prepStatus === "TRANSITIONING") {
        transitioningToNextActivity = true;
        await sleep(1000);
        const afterTransition = await prepareAssessmentScreen(15000);
        if (afterTransition !== "READY") return;
        transitioningToNextActivity = false;
      } else if (prepStatus !== "READY") {
        console.log("Assessment screen did not become ready:", prepStatus);
        return;
      }

      while (isRunning && isContextValid()) {
        const quizStartTime = Date.now();
        const minMs = minSec * 1000;
        const maxMs = maxSec * 1000;
        const targetQuizDurationMs =
          Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;

        console.log("Collecting all questions...");
        const collected = await collectAllQuestions();
        if (!collected || !collected.orderedKeys.length || !isRunning || !isContextValid()) {
          console.error("Failed to collect questions.");
          break;
        }

        const { orderedKeys, questionsMap } = collected;
        const questionsList = Array.from(questionsMap.values());
        const atFirst = await ensureAtFirstQuestion(orderedKeys[0]);

        if (questionsList.length > 0) {
          const batches = chunkArray(questionsList, BATCH_SIZE);
          const allAnswers = await solveBatchesConcurrently(batches);

          if (!allAnswers || !isRunning || !isContextValid()) break;

          const answersByKey = new Map(allAnswers.map((a) => [a.k, a]));

          if (atFirst) {
            for (let i = 0; i < orderedKeys.length; i++) {
              if (!isRunning || !isContextValid()) break;
              const key = orderedKeys[i];

              if (questionsMap.has(key)) {
                await applyQuestionAnswers(questionsMap.get(key), answersByKey.get(key));
              }

              if (i < orderedKeys.length - 1) {
                const nextBtn = document.getElementById("nextQuestion");
                if (isElementVisible(nextBtn)) {
                  nextBtn.click();
                  await waitForActiveQuestion(key, 5000);
                  await sleep(140);
                }
              }
            }
          } else {
            for (const key of orderedKeys) {
              if (!isContextValid()) break;
              if (questionsMap.has(key)) {
                await applyQuestionAnswers(questionsMap.get(key), answersByKey.get(key));
              }
            }
          }

          await sleep(400);
        } else {
          console.log("All questions were textareas handled locally; skipping AI request.");
        }

        if (!isRunning || !isContextValid()) break;

        const submitBtn = document.getElementById("submit");
        if (autoSubmit && isElementVisible(submitBtn)) {
          const elapsedMs = Date.now() - quizStartTime;
          const remainingWaitMs = targetQuizDurationMs - elapsedMs;

          if (remainingWaitMs > 0) {
            console.log(
              `Waiting ${(remainingWaitMs / 1000).toFixed(1)}s before submitting (target quiz duration: ${(targetQuizDurationMs / 1000).toFixed(1)}s)...`
            );
            await sleep(remainingWaitMs);
          }

          if (!isRunning || !isContextValid()) break;

          submitBtn.click();
          console.log("Clicked Submit. Checking for confirmation modal...");

          await waitForAndConfirmSubmit(5000);
          console.log("Waiting for next activity prompt...");

          // 1. Standard quiz overlay ("Click here to continue")
          const clickedNextActivity = await waitForAndClickNextActivity(6000);
          if (clickedNextActivity) {
            transitioningToNextActivity = true;
            await sleep(1000);
            const nextScreenStatus = await prepareAssessmentScreen(15000);
            if (nextScreenStatus === "READY") {
              transitioningToNextActivity = false;
              await sleep(350);
              continue;
            }
          } else if (isRunning && isContextValid()) {
            // 2. Unit Test Review (no continue overlay; use outer player's Next Activity button)
            console.log("No continue overlay found; requesting outer player Next Activity...");
            transitioningToNextActivity = true;
            chrome.runtime.sendMessage({ type: "REQUEST_NEXT_ACTIVITY" }).catch(() => {});
          }
        }

        console.log("Finished quiz.");
        break;
      }
    } finally {
      isRunning = false;
      stopTabKeepAlive();
      if (!transitioningToNextActivity && isContextValid()) {
        await setAutomationState(false, false, minSec, maxSec);
      }
    }
  }

  function isAssessmentFrame() {
    return Boolean(
      document.querySelector(".question-container") ||
      document.querySelector(".overlay-attempt-clickable") ||
      document.querySelector(".overlay-pretest-alert")
    );
  }

  if (isContextValid()) {
    chrome.storage.local.get(["automationState"], (res) => {
      if (!isContextValid()) return;
      const state = res.automationState;
      if (!state?.isRunning) return;

      setTimeout(() => {
        if (isContextValid() && isAssessmentFrame()) {
          runAutomation(state.autoSubmit, state.minDelaySec, state.maxDelaySec);
        }
      }, 700);
    });

    chrome.runtime.onMessage.addListener((msg) => {
      if (!isContextValid()) return;

      if (msg.type === "CLICK_OUTER_NEXT_ACTIVITY") {
        if (window === window.top) {
          clickOuterNextActivity(12000);
        }
        return;
      }

      if (msg.type === "STOP") {
        isRunning = false;
        setAutomationState(false, false);
        return;
      }

      if (!isAssessmentFrame()) return;

      if (msg.type === "START") {
        setAutomationState(true, !!msg.autoSubmit, msg.minDelaySec, msg.maxDelaySec);
        runAutomation(msg.autoSubmit, msg.minDelaySec, msg.maxDelaySec);
      }
    });
  }
})();