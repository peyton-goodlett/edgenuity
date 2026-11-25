const apiKeyInput = document.getElementById("apiKey");
const autoSubmitCheckbox = document.getElementById("autoSubmit");

chrome.storage.local.get(["geminiApiKey", "autoSubmit"], (res) => {
  if (res.geminiApiKey) {
    apiKeyInput.value = res.geminiApiKey;
  }
  if (typeof res.autoSubmit === "boolean") {
    autoSubmitCheckbox.checked = res.autoSubmit;
  }
});

apiKeyInput.addEventListener("change", () => {
  chrome.storage.local.set({ geminiApiKey: apiKeyInput.value.trim() });
});

autoSubmitCheckbox.addEventListener("change", () => {
  chrome.storage.local.set({ autoSubmit: autoSubmitCheckbox.checked });
});

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
  const apiKey = apiKeyInput.value.trim();
  const autoSubmit = autoSubmitCheckbox.checked;

  chrome.storage.local.set({ geminiApiKey: apiKey, autoSubmit });
  sendToActiveTab({ type: "START", autoSubmit });
});

document.getElementById("stopBtn").addEventListener("click", () => {
  sendToActiveTab({ type: "STOP" });
});
