const apiKeyInput = document.getElementById("apiKey");
const autoSubmitCheckbox = document.getElementById("autoSubmit");
const minDelayInput = document.getElementById("minDelay");
const maxDelayInput = document.getElementById("maxDelay");
const delaySection = document.getElementById("delaySection");
const statusBadge = document.getElementById("statusBadge");
const statusText = document.getElementById("statusText");

function updateDelaySectionState() {
  delaySection.classList.toggle("disabled", !autoSubmitCheckbox.checked);
}

function updateStatusBadge(isRunning) {
  statusBadge.classList.toggle("active", Boolean(isRunning));
  statusText.textContent = isRunning ? "Running" : "Idle";
}

function getValidatedDelays() {
  let minSec = Math.max(0, parseInt(minDelayInput.value, 10) || 0);
  let maxSec = Math.max(0, parseInt(maxDelayInput.value, 10) || 0);

  if (maxSec < minSec) {
    maxSec = minSec;
    maxDelayInput.value = maxSec;
  }

  minDelayInput.value = minSec;
  return { minDelaySec: minSec, maxDelaySec: maxSec };
}

function saveSettings() {
  const { minDelaySec, maxDelaySec } = getValidatedDelays();
  chrome.storage.local.set({
    geminiApiKey: apiKeyInput.value.trim(),
    autoSubmit: autoSubmitCheckbox.checked,
    minDelaySec,
    maxDelaySec
  });
}

chrome.storage.local.get(
  ["geminiApiKey", "autoSubmit", "minDelaySec", "maxDelaySec", "automationState"],
  (res) => {
    if (res.geminiApiKey) {
      apiKeyInput.value = res.geminiApiKey;
    }
    if (typeof res.autoSubmit === "boolean") {
      autoSubmitCheckbox.checked = res.autoSubmit;
    }
    if (typeof res.minDelaySec === "number") {
      minDelayInput.value = res.minDelaySec;
    }
    if (typeof res.maxDelaySec === "number") {
      maxDelayInput.value = res.maxDelaySec;
    }

    updateDelaySectionState();
    updateStatusBadge(res.automationState?.isRunning);
  }
);

chrome.storage.onChanged.addListener((changes) => {
  if (changes.automationState) {
    updateStatusBadge(changes.automationState.newValue?.isRunning);
  }
});

apiKeyInput.addEventListener("change", saveSettings);

autoSubmitCheckbox.addEventListener("change", () => {
  updateDelaySectionState();
  saveSettings();
});

minDelayInput.addEventListener("change", saveSettings);
maxDelayInput.addEventListener("change", saveSettings);

async function sendToActiveTab(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id || !tab.url || !/^https?:\/\//i.test(tab.url)) {
    console.warn("Active tab is not a standard webpage:", tab?.url);
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, message);
  } catch (err) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ["content.js"]
      });
      await new Promise((r) => setTimeout(r, 150));
      await chrome.tabs.sendMessage(tab.id, message);
    } catch (injectErr) {
      console.warn("Unable to reach page frames:", injectErr.message);
    }
  }
}

document.getElementById("startBtn").addEventListener("click", () => {
  const { minDelaySec, maxDelaySec } = getValidatedDelays();
  const autoSubmit = autoSubmitCheckbox.checked;

  saveSettings();
  updateStatusBadge(true);

  sendToActiveTab({
    type: "START",
    autoSubmit,
    minDelaySec,
    maxDelaySec
  });
});

document.getElementById("stopBtn").addEventListener("click", () => {
  updateStatusBadge(false);
  sendToActiveTab({ type: "STOP" });
});