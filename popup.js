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

// ===== UI
const btn = document.getElementById("btnToggle");
const statusEl = document.getElementById("status");
const transcriptEl = document.getElementById("transcript");

// Optional controls (if present)
const langSel = document.getElementById("lang");
const wakeSensitivityEl = document.getElementById("wakeSensitivity");

// Debug toggle for cleaner logs
const DEBUG_SHOW_IGNORED = false;

function setStatus(msg) { statusEl && (statusEl.textContent = msg); }
function appendTranscript(text) { transcriptEl && (transcriptEl.textContent += text + "\n"); }
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
            "search_web",
            "click_ui",
            "summarize",
            "rewrite_selection",
            "draft_email",
            "type_text", // ← added
            "focus_ui",                 // ← add this
            "go_back", // ← added
            "refresh", // ← added
            "go_forward" // ← added
          ]
        },
        args: {
          type: "object",
          properties: {
            // open_tab
            url: { type: "string" },
            // scroll
            direction: { type: "string", enum: ["up", "down"] },
            // search_web
            query: { type: "string" },
            // click_ui
            text: { type: "string" },
            // summarize
            target: { type: "string", enum: ["auto", "selection", "email", "page"] },
            // rewrite_selection
            tone: { type: "string" }, // free-form; default "natural"
            // draft_email
            details: { type: "string" }, // free-form gist, e.g., "I'm okay, thanks for the time"
            email_tone: { type: "string" }, // optional: free-form, default polite professional
            // type_text
            text:   { type: "string" },          // what to type (required)
            target: { type: "string" },          // e.g., "search", "email", "subject", "name", or free-form hint
            submit: { type: "boolean" }          // true = press Enter/submit after typing
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
          "For open_tab: command='open_tab' and args.url must be a full https URL.\n" +
          "For scroll: command='scroll', args.direction must be 'up' or 'down'.\n" +
          "For go_back: command='go_back'. args is empty. Trigger on phrases like 'go back', 'back', 'previous page'.\n" +
          "For search_web: command='search_web', args.query is the user's search terms.\n" +
          "For click_ui: command='click_ui', args.text is the visible label to click.\n" +
          "For summarize: command='summarize', args.target is 'auto' unless user says selection/email/page.\n" +
          "For rewrite_selection: command='rewrite_selection'. args.tone is free-form; if missing, assume 'natural'. Return ONLY the rewritten text.\n" +
          "For draft_email: command='draft_email'. args.details is the gist of the reply; args.email_tone is optional (free-form, default 'polite professional'). Return ONLY the draft email text (no subject line).\n" +
          "For type_text: command='type_text'. args.text is the text to type; args.target is the target field (e.g., 'search', 'email', or free-form); args.submit=true to press Enter/submit after typing. Map phrases like \"type/enter/fill ...\" to command='type_text'. Put the literal text into args.text. Put a short target hint in args.target (e.g., \"search\", \"email\", \"subject\", \"name\", or a brief noun phrase). Set args.submit=true only if the user explicitly asks to submit or press enter.\n" +
          "For on-page verbs like \"go to/open/select/choose/activate …\", map to click_ui with args.text as the target label. For \"focus …/put cursor in …\", map to focus_ui with args.text as the target label.\n" +
          "For refresh: command='refresh'. args is empty. Trigger on phrases like 'refresh', 'reload', 'reload this page'.\n" +
          "For go_forward: command='go_forward'. args is empty. Trigger on phrases like 'go forward', 'forward', 'next page'.\n" +
          "Never invent other fields. Never output any text outside the JSON."
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

    appendTranscript("🤖 " + JSON.stringify(parsed, null, 2));

    // Intercepts that run IN THE POPUP (not background)
    if (parsed.command === "summarize") {
      const target = parsed.args?.target || "auto";
      await handleSummarizeFromPopup(target);
      return;
    }
    if (parsed.command === "rewrite_selection") {
      const tone = (parsed.args?.tone || "natural").trim();
      await handleRewriteSelectionFromPopup(tone);
      return;
    }
    if (parsed.command === "draft_email") {
      const details = (parsed.args?.details || "").trim();
      const emailTone = (parsed.args?.email_tone || "polite professional").trim();
      await handleDraftEmailFromPopup(details, emailTone);
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
    }

    // Send the rest to executor (background)
    chrome.runtime.sendMessage(
      { type: "executeCommand", data: parsed },
      (response) => {
        console.log("Executor response:", response);
        if (response?.status === "ok") {
          appendTranscript(`✅ Executed: ${JSON.stringify(response)}`);
        } else if (response?.status === "noop") {
          appendTranscript(`⚠️ Unsupported command`);
        } else {
          appendTranscript(`⚠️ ${response?.message || "Execution failed"}`);
        }
      }
    );
  } catch (err) {
    appendTranscript("❌ AI error: " + err.message);
  }
}

// ===== Summarizer helpers (3.3A1)

let __lazycatSummarizer = null;

function showSummarizerInstallUI(onReady) {
  const panel = document.getElementById("aiSetup");
  const btn = document.getElementById("btnEnableSummarizer");
  if (!panel || !btn) {
    appendTranscript("⚠️ Summarizer setup UI not found in popup.html.");
    return;
  }
  panel.style.display = "block";
  setStatus("Summarizer model required — click to install.");

  btn.onclick = async () => {
    try {
      setStatus("Preparing summarizer…");
      const summarizer = await Summarizer.create({
        type: "tldr",
        format: "markdown",
        length: "medium",
        monitor(m) {
          m.addEventListener("downloadprogress", (e) => {
            setStatus(`Downloading AI model… ${Math.round((e.loaded || 0) * 100)}%`);
          });
        }
      });
      __lazycatSummarizer = summarizer;
      panel.style.display = "none";
      setStatus("Summarizer ready.");
      onReady && onReady(summarizer);
    } catch (e) {
      appendTranscript("❌ Summarizer setup failed: " + e.message);
    }
  };
}

async function getSummarizerOrPrompt() {
  if (__lazycatSummarizer) return __lazycatSummarizer;

  if (!("Summarizer" in self)) {
    appendTranscript("⚠️ Summarizer API not available in this browser.");
    return null;
  }

  const availability = await Summarizer.availability();
  if (availability === "unavailable") {
    appendTranscript("⚠️ Summarizer unavailable on this device.");
    return null;
  }

  if (availability === "available") {
    try {
      __lazycatSummarizer = await Summarizer.create({
        type: "tldr",
        format: "markdown",
        length: "medium"
      });
      return __lazycatSummarizer;
    } catch {
      showSummarizerInstallUI();
      return null;
    }
  }

  showSummarizerInstallUI();
  return null;
}

async function handleSummarizeFromPopup(target = "auto") {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) { appendTranscript("⚠️ No active tab to summarize"); return; }

    const [{ result: extraction }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [target],
      func: (tgt) => {
        const clamp = (s, max = 60000) => (s || "").slice(0, max);
        const getSel = () => (window.getSelection()?.toString() || "").trim();
        const getMainish = () => {
          const picks = [
            document.querySelector("[role='main']"),
            document.querySelector("main"),
            document.querySelector("article")
          ].filter(Boolean);
          const texts = picks
            .map(el => (el.innerText || "").trim())
            .filter(s => s.length > 200)
            .sort((a, b) => b.length - a.length);
          return texts[0] || "";
        };

        let text = "", source = "auto";
        if (tgt === "selection" || tgt === "auto") {
          text = getSel(); if (text) source = "selection";
        }
        if (!text && (tgt === "email" || tgt === "auto")) {
          const m = getMainish(); if (m) { text = m; source = "email/main"; }
        }
        if (!text && (tgt === "page" || tgt === "auto")) {
          const body = (document.body?.innerText || "").trim();
          if (body) { text = body; source = "page"; }
        }

        return { source, text: clamp(text) };
      }
    });

    if (!extraction?.text) {
      appendTranscript("⚠️ Nothing to summarize (no selection/page text)");
      return;
    }

    const summarizer = await getSummarizerOrPrompt();
    if (!summarizer) return;

    setStatus("Summarizing…");
    const summary = await summarizer.summarize(extraction.text, {
      context: "Produce a concise, helpful summary for a busy reader."
    });

    appendTranscript(`📝 Summary (${extraction.source}):\n${summary}`);
    setStatus("Idle");
  } catch (err) {
    appendTranscript("❌ Summarize error: " + err.message);
    setStatus("Idle");
  }
}

// ===== Rewrite selection (3.3A2) — free-form tone
async function handleRewriteSelectionFromPopup(tone = "natural") {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) { appendTranscript("⚠️ No active tab for rewrite"); return; }

    const [{ result: extract }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [],
      func: () => {
        const sel = window.getSelection();
        const hasSelection = sel && sel.rangeCount && sel.toString().trim().length > 0;

        const ae = document.activeElement;
        const isTextInput =
          ae && ((ae.tagName === "TEXTAREA") ||
          (ae.tagName === "INPUT" && /^(text|search|email|tel|url|password)$/i.test(ae.type)) ||
          ae.isContentEditable);

        let mode = "none";
        let text = "";

        if (hasSelection) {
          mode = "selection";
          text = sel.toString();
        } else if (isTextInput) {
          mode = ae.isContentEditable ? "contenteditable" :
                 (ae.tagName === "TEXTAREA" ? "textarea" : "input");
          text = ae.value ?? ae.innerText ?? "";
          if ((mode === "input" || mode === "textarea") && typeof ae.selectionStart === "number" && ae.selectionStart !== ae.selectionEnd) {
            mode = mode + "_range";
            text = (ae.value || "").substring(ae.selectionStart, ae.selectionEnd);
          } else if (mode === "contenteditable" && hasSelection) {
            mode = "contenteditable_range";
            text = sel.toString();
          }
        }

        const clamp = (s, max = 20000) => (s || "").slice(0, max);
        return { mode, text: clamp(text) };
      }
    });

    if (!extract || !extract.text) {
      appendTranscript("⚠️ No selection or editable text to rewrite");
      return;
    }

    const lmAvail = await LanguageModel.availability();
    if (lmAvail === "unavailable") {
      appendTranscript("⚠️ Prompt API unavailable on this device.");
      return;
    }

    const session = await LanguageModel.create({
      output: { type: "text", languageCode: "en" }
    });

    const isConcise = /\b(concise|short|brief|tldr|crisp)\b/i.test(tone);
    const styleHint = tone.toLowerCase() === "natural"
      ? "natural, neutral, and clear (minimal edits)"
      : tone;

    const prompt = [
      {
        role: "system",
        content:
          "Rewrite the user's text. Return ONLY the rewritten text: no quotes, no code fences, no commentary. " +
          "Preserve the original meaning, facts, numbers, names, URLs, and constraints. " +
          "Maintain paragraph breaks. If the text contains placeholders, keep them intact. " +
          (isConcise ? "Be more concise and direct. " : "") +
          `Tone/style: ${styleHint}.`
      },
      { role: "user", content: `Text:\n${extract.text}` }
    ];

    const raw = await session.prompt(prompt);
    session.destroy?.();

    const rewritten = String(raw).replace(/```[\s\S]*?```/g, "").trim();
    if (!rewritten) {
      appendTranscript("⚠️ Rewrite produced empty output");
      return;
    }

    const [{ result: replaced }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [extract.mode, rewritten],
      func: (mode, newText) => {
        const fire = (el) => {
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        };

        const sel = window.getSelection();

        if (mode === "input" || mode === "textarea") {
          const ae = document.activeElement;
          if (!ae) return { success: false, reason: "no_active_element" };
          const desc = mode;
          const setter = Object.getOwnPropertyDescriptor(ae.__proto__, "value") ||
                         Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value") ||
                         Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
          setter?.set?.call(ae, newText);
          fire(ae);
          return { success: true, where: desc };
        }
        if (mode === "input_range" || mode === "textarea_range") {
          const ae = document.activeElement;
          if (!ae || typeof ae.selectionStart !== "number") return { success: false, reason: "no_range" };
          const start = ae.selectionStart, end = ae.selectionEnd;
          ae.setRangeText(newText, start, end, "end");
          fire(ae);
          return { success: true, where: mode };
        }

        if (mode === "contenteditable") {
          const ae = document.activeElement;
          if (!ae || !ae.isContentEditable) return { success: false, reason: "no_contenteditable" };
          ae.innerText = newText;
          fire(ae);
          return { success: true, where: "contenteditable" };
        }
        if (mode === "contenteditable_range" || mode === "selection") {
          if (!sel || !sel.rangeCount) return { success: false, reason: "no_selection_range" };
          const range = sel.getRangeAt(0);
          range.deleteContents();
          range.insertNode(document.createTextNode(newText));
          range.collapse(false);
          sel.removeAllRanges();
          sel.addRange(range);
          return { success: true, where: mode };
        }

        return { success: false, reason: "unsupported_mode" };
      }
    });

    appendTranscript(`✍️ Rewritten (${tone}):\n${rewritten}`);
    if (!replaced?.success) {
      appendTranscript(`ℹ️ Could not auto-insert (${replaced?.reason || "unknown"}). You can copy from above.`);
    } else {
      appendTranscript(`✅ Inserted into ${replaced.where}.`);
    }
  } catch (err) {
    appendTranscript("❌ Rewrite error: " + err.message);
  }
}

// ===== Draft email (3.3A3) — generate + insert; never send
async function handleDraftEmailFromPopup(details, emailTone = "polite professional") {
  try {
    const gist = details || "A brief, polite reply thanking them.";
    const lmAvail = await LanguageModel.availability();
    if (lmAvail === "unavailable") {
      appendTranscript("⚠️ Prompt API unavailable on this device.");
      return;
    }

    const session = await LanguageModel.create({
      output: { type: "text", languageCode: "en" }
    });

    // Keep model output as clean email body (no subject, no signatures unless asked)
    const prompt = [
      {
        role: "system",
        content:
          "Write a short email reply body only (no subject line). " +
          "Return ONLY the email text (no quotes, no code fences, no commentary). " +
          "Tone should follow the user's request. " +
          "Be clear, courteous, and concise. Keep names/placeholders if unspecified."
      },
      {
        role: "user",
        content:
          `Tone: ${emailTone}\n` +
          `Reply gist: ${gist}\n\n` +
          "Constraints:\n" +
          "- No subject line.\n" +
          "- No markdown.\n" +
          "- Keep greeting and sign-off minimal.\n" +
          "- Preserve any explicit facts if given.\n"
      }
    ];

    const raw = await session.prompt(prompt);
    session.destroy?.();

    const bodyText = String(raw).replace(/```[\s\S]*?```/g, "").trim();
    if (!bodyText) {
      appendTranscript("⚠️ Draft produced empty output");
      return;
    }

    // Also show in transcript for copy
    appendTranscript(`📧 Draft (${emailTone}):\n${bodyText}`);

    // Try inserting into an open compose editor (Gmail/Outlook/webmail)
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;

    const [{ result: inserted }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [bodyText],
      func: (plainText) => {
        const isVisible = (el) => !!(el && el.offsetParent !== null);

        const toHTML = (txt) => {
          const esc = (s) => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
          // paragraphs: split on blank lines
          const parts = txt.split(/\n\s*\n/);
          return parts.map(p => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
        };

        const candidates = [
          // Gmail
          'div[aria-label="Message Body"]',
          'div[aria-label="Message body"]',
          // Outlook web
          'div[aria-label="Message body"][contenteditable="true"]',
          'div[role="textbox"][contenteditable="true"]',
          // Generic rich editors
          'div[contenteditable="true"]',
          // As a last resort
          'textarea'
        ];

        let target = null;
        for (const sel of candidates) {
          const els = Array.from(document.querySelectorAll(sel)).filter(isVisible);
          if (els.length) { target = els[0]; break; }
        }

        if (!target) return { success: false, reason: "no_compose_editor" };

        const isRich = target.isContentEditable;
        if (isRich) {
          target.innerHTML = toHTML(plainText);
          target.dispatchEvent(new Event("input", { bubbles: true }));
          target.dispatchEvent(new Event("change", { bubbles: true }));
          return { success: true, where: "contenteditable" };
        }

        // textarea fallback
        if (target.tagName === "TEXTAREA") {
          const setter =
            Object.getOwnPropertyDescriptor(target.__proto__, "value") ||
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
          setter?.set?.call(target, plainText);
          target.dispatchEvent(new Event("input", { bubbles: true }));
          target.dispatchEvent(new Event("change", { bubbles: true }));
          return { success: true, where: "textarea" };
        }

        return { success: false, reason: "unknown_target_type" };
      }
    });

    if (inserted?.success) {
      appendTranscript(`✅ Inserted into ${inserted.where}. (Not sent)`);
    } else {
      appendTranscript(`ℹ️ Could not auto-insert (${inserted?.reason || "unknown"}). You can copy the draft above.`);
    }
  } catch (err) {
    appendTranscript("❌ Draft error: " + err.message);
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
  recognition.interimResults = true;     // we only act on finals
  recognition.maxAlternatives = 5;

  recognition.onstart = () => setStatus("Listening… say 'Hey Cat' or 'Lazy Cat'.");
  recognition.onerror = (e) => setStatus("Error: " + e.error);
  recognition.onend = () => {
    if (listening) recognition.start();
    else setStatus("Stopped.");
  };

  recognition.onresult = (event) => {
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
        appendTranscript("🐱 " + afterWake);
        aiInterpret(afterWake);
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
      appendTranscript("🐱 " + chosen);
      aiInterpret(chosen);
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
