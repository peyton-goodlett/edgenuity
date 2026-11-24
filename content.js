let isRunning = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setAutomationState(running, autoSubmit = false) {
  return chrome.storage.local.set({
    automationState: { isRunning: running, autoSubmit }
  });
}

function getActiveQuestionContainer() {
  const containers = document.querySelectorAll(
    ".question-container > .Assessment_Main_Body_Content_Question"
  );
  for (const el of containers) {
    if (el.style.display !== "none" && el.offsetParent !== null) {
      return el;
    }
  }
  return null;
}

function isElementVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    el.offsetParent !== null
  );
}

function extractQuestionData(activeContainer) {
  const contents = activeContainer.querySelector(".Question_Contents");
  if (!contents) return null;

  const bodyBlocks = Array.from(contents.querySelectorAll(".Practice_Question_Body"));
  const textParts = bodyBlocks
    .filter((block) => !block.querySelector(".answer-choice"))
    .map((block) => block.innerText.trim())
    .filter(Boolean);

  const imageUrls = Array.from(contents.querySelectorAll("img"))
    .map((img) => img.src)
    .filter((src) => src && !src.startsWith("data:image/gif"));

  const choices = Array.from(contents.querySelectorAll(".answer-choice"))
    .map((choiceEl) => {
      const input = choiceEl.querySelector("input.answer-choice-button");
      const label = choiceEl.querySelector("label.answer-choice-label");
      return {
        id: input ? input.id : "",
        text: label ? label.innerText.trim() : ""
      };
    })
    .filter((c) => c.id && c.text);

  if (!choices.length) return null;

  return {
    questionKey: activeContainer.querySelector("input.question-key")?.value || "",
    questionText: textParts.join("\n\n"),
    imageUrls,
    choices
  };
}

/**
 * Handles pre-quiz overlays regardless of where the user starts or where a reload lands:
 * 1. "Click to begin the next activity" alert (.overlay-pretest-alert)
 * 2. "Click to Begin Pre-Test" button (button.overlay-attempt-clickable)
 * 3. Waits until an active question with choices is rendered in the DOM
 */
async function prepareAssessmentScreen(timeoutMs = 15000) {
  const start = Date.now();
  let clickedBegin = false;

  while (Date.now() - start < timeoutMs) {
    if (!isRunning) return "STOPPED";

    // 1. If the post-pretest "next activity" alert is visible, click it
    const alertBox = document.querySelector(".overlay-pretest-alert");
    if (isElementVisible(alertBox)) {
      const nextActivityLink = alertBox.querySelector("a");
      if (nextActivityLink) {
        await sleep(500);
        nextActivityLink.click();
        console.log("Clicked 'Click to begin the next activity'.");
        return "TRANSITIONING";
      }
    }

    // 2. If the "Click to Begin Pre-Test" overlay button is visible, click it once
    const beginBtn = document.querySelector("button.overlay-attempt-clickable");
    if (isElementVisible(beginBtn) && !clickedBegin) {
      await sleep(500); // Allow Knockout.js data-bind handlers to attach
      beginBtn.click();
      clickedBegin = true;
      console.log("Clicked 'Click to Begin' button. Waiting for questions...");
    }

    // 3. Check if an active question with choices is visible and ready
    const active = getActiveQuestionContainer();
    if (active && !isElementVisible(alertBox) && !isElementVisible(beginBtn)) {
      const currentKey = active.querySelector("input.question-key")?.value || "";
      const hasChoices = active.querySelectorAll(".answer-choice").length > 0;
      if (currentKey && hasChoices) {
        return "READY";
      }
    }

    await sleep(300);
  }

  return "TIMEOUT";
}

async function waitForActiveQuestion(excludeKey = null, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const active = getActiveQuestionContainer();
    if (active) {
      const currentKey = active.querySelector("input.question-key")?.value || "";
      const hasChoices = active.querySelectorAll(".answer-choice").length > 0;
      const alertVisible = isElementVisible(document.querySelector(".overlay-pretest-alert"));

      if (currentKey && hasChoices && !alertVisible && (!excludeKey || currentKey !== excludeKey)) {
        return true;
      }
    }
    await sleep(300);
  }
  return false;
}

async function waitForAndClickNextActivity(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const alertBox = document.querySelector(".overlay-pretest-alert");
    if (isElementVisible(alertBox)) {
      const nextActivityLink = alertBox.querySelector("a");
      if (nextActivityLink) {
        await sleep(500);
        nextActivityLink.click();
        return true;
      }
    }
    await sleep(300);
  }
  return false;
}

async function sendSolveRequest(payload, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: "SOLVE_QUESTION",
        payload
      });

      if (response?.success) {
        return response;
      }

      if ((response?.status === 429 || response?.status === 503) && attempt < maxRetries - 1) {
        await sleep(3000);
        continue;
      }

      return response || { success: false, error: "No response from background worker." };
    } catch (err) {
      console.warn(`Message port interrupted (attempt ${attempt + 1}/${maxRetries}):`, err.message);
      if (attempt < maxRetries - 1) {
        await sleep(1500);
        continue;
      }
      return { success: false, error: err.message };
    }
  }
}

async function runAutomation(autoSubmit) {
  if (isRunning) return;
  isRunning = true;
  let transitioningToNextActivity = false;

  try {
    // Handle initial state (Begin Next alert, Start Pre-Test overlay, or existing question)
    const prepStatus = await prepareAssessmentScreen(15000);

    if (prepStatus === "TRANSITIONING") {
      transitioningToNextActivity = true;
      // If the page transitions via AJAX without reloading the frame, wait for the next overlay/question
      await sleep(1500);
      const afterTransition = await prepareAssessmentScreen(15000);
      if (afterTransition !== "READY") {
        return;
      }
      transitioningToNextActivity = false;
    } else if (prepStatus !== "READY") {
      console.log("Assessment screen did not become ready:", prepStatus);
      return;
    }

    while (isRunning) {
      const activeContainer = getActiveQuestionContainer();
      if (!activeContainer) {
        console.log("No active question container found in this frame.");
        break;
      }

      const payload = extractQuestionData(activeContainer);
      if (!payload) {
        console.warn("Could not extract choices (may not be a multiple-choice question).");
        break;
      }

      const response = await sendSolveRequest(payload);

      if (!response || !response.success) {
        console.error("Failed to get answer:", response?.error);
        break;
      }

      const radio = document.getElementById(response.selectedId);
      if (!radio) {
        console.error("Returned ID not found in DOM:", response.selectedId);
        break;
      }

      radio.checked = true;
      radio.click();
      radio.dispatchEvent(new Event("change", { bubbles: true }));

      // Wait briefly for /ChangeQuestionAnswer AJAX POST to complete
      await sleep(1000);

      const nextBtn = document.getElementById("nextQuestion");
      const submitBtn = document.getElementById("submit");

      if (isElementVisible(nextBtn)) {
        nextBtn.click();
        const loaded = await waitForActiveQuestion(payload.questionKey);
        if (!loaded) {
          console.log("Next question did not load; stopping.");
          break;
        }
        await sleep(500);
      } else {
        if (autoSubmit && isElementVisible(submitBtn)) {
          submitBtn.click();
          console.log("Submitted assessment. Waiting for next activity alert...");

          const clickedNextActivity = await waitForAndClickNextActivity();
          if (clickedNextActivity) {
            transitioningToNextActivity = true;
            console.log("Clicked next activity. Waiting for next screen...");

            await sleep(1500);
            const nextScreenStatus = await prepareAssessmentScreen(15000);
            if (nextScreenStatus === "READY") {
              transitioningToNextActivity = false;
              await sleep(500);
              continue;
            }
          }
        }
        console.log("Reached the end of the assessment.");
        break;
      }
    }
  } finally {
    isRunning = false;
    if (!transitioningToNextActivity) {
      await setAutomationState(false, false);
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

// Auto-resume when a new activity loads into a fresh iframe
chrome.storage.local.get(["automationState"], (res) => {
  const state = res.automationState;
  if (!state?.isRunning) return;

  // Give Knockout templates a moment to render before checking frame elements
  setTimeout(() => {
    if (isAssessmentFrame()) {
      runAutomation(state.autoSubmit);
    }
  }, 800);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "STOP") {
    isRunning = false;
    setAutomationState(false, false);
    return;
  }

  if (!isAssessmentFrame()) return;

  if (msg.type === "START") {
    setAutomationState(true, !!msg.autoSubmit);
    runAutomation(msg.autoSubmit);
  }
});