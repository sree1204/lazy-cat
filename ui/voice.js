console.log("Voice module loaded ✅");

const btn = document.getElementById("mic");
const statusEl = document.getElementById("status");
const out = document.getElementById("transcript");

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
let listening = false;

function setStatus(s) { statusEl.textContent = s; }
function setTranscript(t) { out.textContent = t; }

function startListening() {
  if (!SR) {
    alert("SpeechRecognition not available in this Chrome. We'll add AI audio later.");
    return;
  }

  rec = new SR();
  rec.lang = "en-US";
  rec.continuous = true;
  rec.interimResults = true;

  rec.onstart = () => {
    listening = true;
    btn.textContent = "🛑 Stop";
    setStatus("listening…");
  };

  rec.onend = () => {
    listening = false;
    btn.textContent = "🎙️ Start";
    setStatus("idle");
  };

  rec.onerror = (e) => {
    console.error("SpeechRecognition error:", e);
    setStatus("error");
  };

  rec.onresult = (e) => {
    let finalText = "", interimText = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalText += t + " ";
      else interimText += t;
    }
    setTranscript((finalText || interimText).trim());

    // when we have final text, send it to background
    if (finalText.trim()) {
      chrome.runtime.sendMessage({ type: "TRANSCRIPT", text: finalText.trim() });
    }
  };

  rec.start();
}

function stopListening() {
  if (rec) rec.stop();
}

btn.addEventListener("click", () => listening ? stopListening() : startListening());
