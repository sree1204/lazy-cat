console.log("Content script loaded ✅");

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log("Content script got message:", msg);

  if (msg.type === "PING_FROM_BG") {
    console.log("Content replying to background...");
    sendResponse({ reply: "Hello from content script!" });
  }
});
