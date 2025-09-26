console.log("Popup loaded ✅");

document.getElementById("test").addEventListener("click", () => {
  console.log("Popup sending message...");
  chrome.runtime.sendMessage(
    { type: "FROM_POPUP", data: "Hi BG" },
    (res) => {
      console.log("Popup got back:", res);
      alert("Content says: " + (res ? res.reply : "no response"));
    }
  );
});
