console.log("Background script loaded ✅");

chrome.runtime.onInstalled.addListener(() => {
  console.log("Lazy Cat extension installed ✅");
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log("Background listener triggered. Message:", msg);

  if (msg.type === "FROM_POPUP") {
    console.log("Background got FROM_POPUP:", msg);

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(
          tabs[0].id,
          { type: "PING_FROM_BG" },
          (res) => {
            if (chrome.runtime.lastError) {
              console.warn("No content script in this page:", chrome.runtime.lastError.message);
              sendResponse({ reply: "Background alive ✅ but no content here" });
            } else {
              console.log("Background got reply from content:", res);
              sendResponse(res);
            }
          }
        );
      }
    });

    return true;
  }

  if (msg.type === "TRANSCRIPT") {
    console.log("[Transcript received]:", msg.text);
  }
});
