const apiKeyInput = document.getElementById("apiKey");
const autoSubmitCheckbox = document.getElementById("autoSubmit");

chrome.storage.local.get(["geminiApiKey"], (res) => {
  if (res.geminiApiKey) apiKeyInput.value = res.geminiApiKey;
});

apiKeyInput.addEventListener("change", () => {
  chrome.storage.local.set({ geminiApiKey: apiKeyInput.value.trim() });
});

async function sendToActiveTab(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, message);
}

document.getElementById("startBtn").addEventListener("click", () => {
  chrome.storage.local.set({ geminiApiKey: apiKeyInput.value.trim() });
  sendToActiveTab({ type: "START", autoSubmit: autoSubmitCheckbox.checked });
});

document.getElementById("stopBtn").addEventListener("click", () => {
  sendToActiveTab({ type: "STOP" });
});