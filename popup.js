// Lazy Cat popup — checkpoint through 3.3A3
// Voice engine (final-only, fuzzy wake, language select, wake timeout)
// AI router (JSON schema + cleanup)
// Background executor messaging (open_tab, scroll, search_web, click_ui)
// Summarize in popup (selection/email/page) with gesture-gated download
// Rewrite selection in popup (free-form tone, default natural)
// Draft email in popup (generate + insert into compose editor; no sending)

let listening = false;
let recognition;
let wakeActive = false;
let wakeTimer = null;
let processingUtterance = false; // prevent overlapping handling

// ===== UI
const btn = document.getElementById("btnToggle");
const statusEl = document.getElementById("status");
const transcriptEl = document.getElementById("transcript");

// Minimal display: show only current command and latest execution
function setDisplay(current, execution) {
  if (!transcriptEl) return;
  const lines = [];
  if (current) lines.push(`Command: ${current}`);
  if (execution) lines.push(`Execution: ${execution}`);
  transcriptEl.textContent = lines.join("\n");
}
function setCurrentDisplay(current) { setDisplay(current, null); }
function setExecutionDisplay(execution) {
  if (!transcriptEl) return;
  const existing = transcriptEl.textContent || "";
  const currentLine = existing.split("\n")[0] || "";
  const current = currentLine.replace(/^Command:\s*/, "");
  setDisplay(current || null, execution);
}

// Optional controls (if present)
const langSel = document.getElementById("lang");
const wakeSensitivityEl = document.getElementById("wakeSensitivity");

// Debug toggle for cleaner logs
const DEBUG_SHOW_IGNORED = false;

function setStatus(msg) { statusEl && (statusEl.textContent = msg); }
function appendTranscript(_text) { /* minimized UI: no verbose logging */ }
function clearWakeTimer() { if (wakeTimer) { clearTimeout(wakeTimer); wakeTimer = null; } }
function armWakeTimeout() {
  clearWakeTimer();
  wakeTimer = setTimeout(() => {
    wakeActive = false;
    setStatus("Wake timed out. Say 'Hey Cat' or 'Lazy Cat' again.");
  }, 5000);
}

// ===== Wake detection (fuzzy)
const BASE_WAKE_VARIANTS = [
  "hey cat", "lazy cat",
  "he got", "hey cut", "lazy cut", "hey cap", "hey cad", "hey kit", "hey kate", "hey cats"
];

function editDistanceAtMost(s, t, maxD = 2) {
  const m = s.length, n = t.length;
  if (Math.abs(m - n) > maxD) return maxD + 1;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    let minRow = dp[0];
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(
        dp[j] + 1,
        dp[j - 1] + 1,
        prev + (s[i - 1] === t[j - 1] ? 0 : 1)
      );
      prev = tmp;
      if (dp[j] < minRow) minRow = dp[j];
    }
    if (minRow > maxD) return maxD + 1;
  }
  return dp[n];
}

// sensitivity: 0=strict, 1=default, 2=loose
function wakeMatches(text, sensitivity = 1) {
  const lower = text.toLowerCase();
  // fast path: direct substring
  let best = null;
  for (const v of BASE_WAKE_VARIANTS) {
    const idx = lower.indexOf(v);
    if (idx !== -1 && (!best || idx < best.index)) best = { index: idx, match: v };
  }
  if (best) return best;

  // fuzzy near beginning
  const windowText = lower.slice(0, 40);
  const maxD = sensitivity === 0 ? 1 : sensitivity === 1 ? 2 : 3;
  for (const v of BASE_WAKE_VARIANTS) {
    for (let i = 0; i <= Math.max(0, windowText.length - v.length); i++) {
      const cand = windowText.slice(i, i + v.length);
      if (editDistanceAtMost(cand, v, maxD) <= maxD) return { index: i, match: v };
    }
  }
  return null;
}
function stripAfterWake(text, sensitivity = 1) {
  const info = wakeMatches(text, sensitivity);
  if (!info) return null;
  return text.slice(info.index + info.match.length).trim();
}

// ===== AI Router
async function aiInterpret(commandText) {
  try {
    const availability = await LanguageModel.availability();
    if (availability === "unavailable") {
      appendTranscript("⚠️ Prompt API unavailable on this device.");
      return;
    }

    const schema = {
      type: "object",
      properties: {
        command: {
          type: "string",
          enum: [
            "open_tab",
            "scroll",
            "scroll_bottom",
            "scroll_top",
            "search_web",
            "type_text",
            "focus_ui",
            "go_back",
            "refresh",
            "go_forward",
            "close_tab",
            "next_tab",
            "previous_tab",
            "open_window",
            "window_fullscreen_on",
            "window_fullscreen_off",
            "pop_tab_to_window",
            "ask_page"
          ]
        },
        args: {
          type: "object",
          properties: {

            // Replace the existing `url` property with the updated schema
            url: { 
              type: "string", 
              description: "Full https:// URL if user asked to open a website. Omit only if the user explicitly said 'open new tab' or 'blank tab'. Never leave it empty when a site/domain is mentioned." 
            },
            // scroll
            direction: { type: "string", enum: ["up", "down"] },
            // search_web
            query: { type: "string" },
            // type_text
            text:   { type: "string" },          // what to type (required)
            target: { type: "string" },          // e.g., "search", "email", "subject", "name", or free-form hint
            submit: { type: "boolean" },         // true = press Enter/submit after typing
            // new question property
            question: { type: "string", description: "User's natural language question about the current page content" }
          },
          additionalProperties: false
        },
        confirmation: { type: "string", enum: ["none", "required"] }
      },
      required: ["command", "args", "confirmation"]
    };

    const session = await LanguageModel.create({
      output: { type: "text", languageCode: "en" },
      responseConstraint: { type: "json_schema", schema },
      monitor(m) {
        m.addEventListener("downloadprogress", (e) => {
          setStatus(`Downloading AI model… ${Math.round((e.loaded || 0) * 100)}%`);
        });
      }
    });

    const raw = await session.prompt([
      {
        role: "system",
        content:
          "You are Lazy Cat's command router.\n" +
          "Output ONLY valid JSON per schema. Exactly one command per request.\n" +
          "Open tab rules:\n" +
          "• If user says 'open new tab', 'create new tab', 'blank tab' → command='open_tab' with NO url.\n" +
          "• If user says 'open <site>' like 'amazon', 'youtube', 'gmail', etc. → command='open_tab' with args.url = full https:// URL.\n" +
          "   - Always expand to 'https://<site>.com' unless a full URL is already given.\n" +
          "   - Example: 'open amazon' → {command:'open_tab', args:{url:'https://amazon.com'}}\n" +
          "• Never output 'open_tab' without url when the phrase includes a website name.\n" +
          "Scrolling rules:\n" +
          "• Use command='scroll' with args.direction='up' or 'down' ONLY for small step movements (phrases like 'scroll down', 'scroll up', 'slide down', 'move up a bit').\n" +
          "• Use command='scroll_bottom' ONLY for explicit requests to go all the way to the end of the page (phrases like 'scroll to bottom', 'all the way down', 'end of page').\n" +
          "• Use command='scroll_top' ONLY for explicit requests to go all the way to the top (phrases like 'scroll to top', 'all the way up', 'back to top').\n" +
          "Never substitute 'scroll' for 'scroll_bottom' or 'scroll_top'.\n" +
          "For go_back: command='go_back'. args is empty. Trigger on phrases like 'go back', 'back', 'previous page'.\n" +
          "Search rules (STRICT):\n" +
          "• Use command='search_web' ONLY when the user says an explicit search verb such as: 'search', 'search for', 'look for', 'look up', 'find', or 'google'.\n" +
          "• If the user does NOT use an explicit search verb, DO NOT use 'search_web'. Prefer 'type_text' targeting a search field, and do NOT submit.\n" +
          "• Never infer a search from a bare noun phrase.\n" +
          "For search_web (when explicit only): command='search_web', args.query is the user's search terms.\n" +
          "Clicking is temporarily disabled. Do not use any click commands.\n" +
          "For type_text: command='type_text'. args.text is the text to type; args.target is the target field (e.g., 'search', 'email', or free-form); args.submit=true to press Enter/submit after typing. Map phrases like \"type/enter/fill ...\" to command='type_text'. Put the literal text into args.text. Put a short target hint in args.target (e.g., \"search\", \"email\", \"subject\", \"name\", or a brief noun phrase). Set args.submit=true only if the user explicitly asks to submit or press enter.\n" +
          "For focus requests (e.g., 'focus search box', 'put cursor in email'), use command='focus_ui' with args.text as the target label.\n" +
          "For refresh: command='refresh'. args is empty. Trigger on phrases like 'refresh', 'reload', 'reload this page'.\n" +
          "For go_forward: command='go_forward'. args is empty. Trigger on phrases like 'go forward', 'forward', 'next page'.\n" +
          "For close_tab: command='close_tab'. args is empty. Trigger on explicit phrases like 'close tab', 'shut this tab', 'remove current tab'.\n" +
          "For 'next tab' or 'switch tab right' use command='next_tab'.\n" +
          "For 'previous tab' or 'switch tab left' use command='previous_tab'.\n" +
          "For opening a website (e.g., 'open amazon', 'open youtube.com'), use command='open_tab' with url.\n" +
          "For a blank/empty tab (e.g., 'open new tab', 'create new tab'), use command='open_tab' with NO url.\n" +
          "For explicit phrases like 'open new window', 'create window', or 'new browser window', use command='open_window'.\n" +
          "Never use 'open_window' for websites — those must always be 'open_tab'.\n" +
          "For explicit phrases like 'go fullscreen', 'enter fullscreen', 'open fullscreen mode' use command='window_fullscreen_on'.\n" +
          "For explicit phrases like 'exit fullscreen', 'leave fullscreen', 'restore window' use command='window_fullscreen_off'.\n" +
          "Never use this for opening websites or windows.\n" +
          "For explicit phrases like 'open this page in a new window', 'pop this tab out', 'move this tab to a new window' use command='pop_tab_to_window'.\n" +
          "Never confuse this with 'open_window' (creates empty window) or 'open_tab' (creates a new tab).\n" +
          "Never invent other fields. Never output any text outside the JSON." +
          "For natural language questions about the current page (e.g., \"What are the dimensions?\", \"Who is the author?\", \"When was this posted?\"), use command='ask_page' with args.question containing the user's exact question."
      },
      { role: "user", content: commandText }
    ]);

    session.destroy?.();

    console.log("DEBUG raw result:", raw);

    // Cleanup code fences if any
    let cleaned = String(raw).replace(/```json/gi, "").replace(/```/g, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      parsed = { command: "noop", args: {}, confirmation: "none", error: "Could not parse AI output" };
    }

  // Minimal UI: show current command
  try {
    const argStr = parsed?.args ? JSON.stringify(parsed.args) : "{}";
    setCurrentDisplay(`${parsed.command} ${argStr}`);
  } catch { setCurrentDisplay(String(parsed?.command || "")); }

  // Intercepts removed for simplified UI
    // Guard: clicking disabled for now
    if (parsed.command === "click_ui") {
      setExecutionDisplay("click disabled");
      return;
    }
    if (parsed.command === "type_text") {
      // Clean leaked verbs from args.text
      parsed.args.text = sanitizeTypedText(parsed.args.text || "");

      // Be conservative: only auto-submit for obvious search intent
      const tHint = (parsed.args.target || "").toLowerCase();
      if (parsed.args.submit && !/^(search|query)$/.test(tHint)) {
        parsed.args.submit = false;
      }
      // New: if the utterance did not include an explicit search verb, never auto-submit
      if (parsed.args.submit && !isExplicitSearch(commandText)) {
        parsed.args.submit = false;
      }
    }

    // Enforce strict search gating: only allow search_web with explicit verbs
    if (parsed.command === "search_web" && !isExplicitSearch(commandText)) {
      const q = (parsed.args?.query || "").trim();
      // Downgrade to typing into search without submit
      parsed = {
        command: "type_text",
        args: { text: q, target: "search", submit: false },
        confirmation: "none"
      };
      setCurrentDisplay(`${parsed.command} ${JSON.stringify(parsed.args)}`);
    }

    // Send the rest to executor (background)
    chrome.runtime.sendMessage(
      { type: "executeCommand", data: parsed },
      (response) => {
        let msg = "";
        if (response?.status === "ok") {
          const action = response?.action ? ` ${response.action}` : "";
          msg = `ok${action}`.trim();
        } else if (response?.status === "noop") {
          msg = "unsupported";
        } else {
          msg = response?.message || "failed";
        }
        setExecutionDisplay(msg);
      }
    );
  } catch (err) {
    setExecutionDisplay("AI error: " + err.message);
  }
}


// ===== Speech Recognition (accuracy-focused)
function initRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    setStatus("SpeechRecognition not supported in this browser.");
    btn && (btn.disabled = true);
    return;
  }

  recognition = new SpeechRecognition();
  recognition.lang = (localStorage.getItem("lc_lang") || "en-US");
  recognition.continuous = true;
  // Make results cleaner by only receiving finals and fewer variants
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    processingUtterance = false; // reset guard on fresh start
    setStatus("Listening… say 'Hey Cat' or 'Lazy Cat'.");
  };
  recognition.onerror = (e) => setStatus("Error: " + e.error);
  recognition.onend = () => {
    // release guard on session end before auto-restart
    processingUtterance = false;
    if (listening) recognition.start();
    else setStatus("Stopped.");
  };

  recognition.onresult = (event) => {
    if (processingUtterance) return; // ignore any late events while we're handling one
    const res = event.results[event.results.length - 1];
    if (!res || !res.isFinal) return;

    const alts = [];
    for (let i = 0; i < res.length; i++) {
      const t = (res[i].transcript || "").trim();
      if (t) alts.push(t);
    }
    if (!alts.length) return;

    const sens = Number(localStorage.getItem("lc_wake_sens") ?? "1");
    let chosen = null;
    for (const t of alts) {
      if (wakeMatches(t.toLowerCase(), sens)) { chosen = t; break; }
    }
    if (!chosen) chosen = alts.slice().sort((a, b) => b.length - a.length)[0];

  const lower = chosen.toLowerCase();

    const afterWake = stripAfterWake(lower, sens);
    if (afterWake !== null) {
      if (afterWake) {
        const cleaned = denoiseUtterance(afterWake);
        if (cleaned) {
          appendTranscript("🐱 " + cleaned);
          processingUtterance = true;
          aiInterpret(cleaned);
        }
        wakeActive = false;
        clearWakeTimer();
        recognition.stop();
      } else {
        setStatus("Wake word detected — waiting for your command…");
        wakeActive = true;
        armWakeTimeout();
      }
      return;
    }

    if (wakeActive) {
      const cleaned = denoiseUtterance(chosen);
      if (cleaned) {
        appendTranscript("🐱 " + cleaned);
        processingUtterance = true;
        aiInterpret(cleaned);
      }
      wakeActive = false;
      clearWakeTimer();
      recognition.stop();
      return;
    }

    if (DEBUG_SHOW_IGNORED) appendTranscript("(ignored) " + chosen);
    recognition.stop();
  };
}

// UI wiring
btn && btn.addEventListener("click", () => {
  if (!recognition) initRecognition();

  if (!listening) {
    listening = true;
    recognition.start();
    btn.textContent = "🛑 Stop Listening";
  } else {
    listening = false;
    recognition.stop();
    btn.textContent = "🎤 Start Listening";
  }
});

// Persist language & sensitivity
if (langSel) {
  const savedLang = localStorage.getItem("lc_lang");
  if (savedLang) langSel.value = savedLang;
  langSel.addEventListener("change", () => {
    localStorage.setItem("lc_lang", langSel.value);
    if (recognition) recognition.lang = langSel.value;
    setStatus(`Language set to ${langSel.value}`);
  });
}
if (wakeSensitivityEl) {
  const savedSens = localStorage.getItem("lc_wake_sens");
  if (savedSens !== null) wakeSensitivityEl.value = savedSens;
  wakeSensitivityEl.addEventListener("input", () => {
    localStorage.setItem("lc_wake_sens", wakeSensitivityEl.value);
    setStatus(`Wake sensitivity: ${wakeSensitivityEl.value}`);
  });
}

// helper to sanitize typed text before sending commands
function sanitizeTypedText(s) {
  if (!s) return s;
  let out = String(s);

  // strip leading verbs
  out = out.replace(/^\s*(type|enter|fill|write)\s+/i, "");

  // strip trailing field references: " ... in/on/into (subject|email|name|search|box|field)"
  out = out.replace(/\s+(in|on|into)\s+(subject|email|name|search|box|field)\s*$/i, "");

  // strip outer quotes/backticks if any
  out = out.replace(/^['"`]\s*|\s*['"`]$/g, "");

  return out.trim();
}

// Explicit search intent detector: only true for clear verbs
function isExplicitSearch(text) {
  if (!text) return false;
  const t = String(text).toLowerCase();
  // order matters: check phrases before single words
  const patterns = [
    /\bsearch\s+for\b/,
    /\blook\s+for\b/,
    /\blook\s+up\b/,
    /\bfind\b/,
    /\bsearch\b/,
    /\bgoogle\b/
  ];
  return patterns.some((re) => re.test(t));
}

// Text denoiser: remove fillers and overlapping/duplicate words to keep speech clear
function denoiseUtterance(s) {
  if (!s) return s;
  let t = String(s);

  // remove common fillers at boundaries or isolated
  t = t.replace(/\b(um+|uh+|er+|ah+|like)\b\s*/gi, "");

  // collapse repeated words: "open open tab" -> "open tab"
  // do this conservatively for up to 3 repetitions
  for (let i = 0; i < 3; i++) {
    t = t.replace(/\b(\w+)(\s+\1\b)+/gi, "$1");
  }

  // remove duplicated functional verb pairs (open/open, click/click)
  t = t.replace(/\b(open|click|go|scroll|type|enter|press)\s+\1\b/gi, "$1");

  // trim extra spaces
  t = t.replace(/\s{2,}/g, " ").trim();

  return t;
}
