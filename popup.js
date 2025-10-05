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
const RESTART_COOLDOWN_MS = 350; // small delay to avoid carryover overlap

// ===== UI
const btn = document.getElementById("btnToggle");
const statusEl = document.getElementById("status");
const currentCard = document.getElementById("current");
const currentCmdEl = document.getElementById("currentCmd");
const resultEl = document.getElementById("result");
const thinkingBadge = document.getElementById("thinking");

// Voice settings removed: use fixed moderate defaults

// Debug toggle for cleaner logs
const DEBUG_SHOW_IGNORED = false;

function setStatus(msg) { statusEl && (statusEl.textContent = msg); }
function appendTranscript(text) {
  if (!resultEl) return;
  // replace previous content with current output; extend if large
  resultEl.textContent = String(text);
}
function setCurrentCommand(text) { currentCmdEl && (currentCmdEl.textContent = text); }
function setThinking(on) {
  if (!currentCard || !thinkingBadge) return;
  currentCard.classList.toggle("thinking", !!on);
  thinkingBadge.style.display = on ? "inline" : "none";
}
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
    setThinking(true);
    // Provide page context to AI so it can infer Gmail-specific intents
    let currentUrl = "";
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      currentUrl = tab?.url || "";
    } catch (_) {}
    const availability = await LanguageModel.availability();
    if (availability === "unavailable") {
      appendTranscript("⚠️ Prompt API unavailable on this device.");
      setThinking(false);
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
            "summarize",
            "rewrite_selection",
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
            "ask_page",
            "open_email",
            "open_gmail_section"
            ,
            "gmail_reply",
            "gmail_forward",
            "gmail_update_recipients",
            "gmail_send"
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
            // click_ui
            text: { type: "string" },
            // summarize
            target: { type: "string", enum: ["auto", "selection", "email", "page"] },
            // rewrite_selection
            tone: { type: "string" }, // free-form; default "natural"
            
            // type_text
            text:   { type: "string" },          // what to type (required)
            target: { type: "string" },          // e.g., "search", "email", "subject", "name", or free-form hint
            submit: { type: "boolean" },          // true = press Enter/submit after typing
            // new question property
            question: { type: "string", description: "User's natural language question about the current page content" },
            // translate_page
            lang: { type: "string", description: "Target language (ISO code like 'en', 'es', or a name like 'spanish'). Optional: if omitted, use default." },
            // open_email
            index: { type: "number", description: "Email index/position (1-based) in the inbox list" },
            sender: { type: "string", description: "Filter by sender name or email address" },
            subject: { type: "string", description: "Filter by subject text or keywords" }
            ,
            // gmail_reply
            mode: { type: "string", description: "Reply mode: 'reply' or 'reply_all'", enum: ["reply","reply_all"] },
            // gmail_forward / gmail_update_recipients / gmail_send
            to: { type: "array", items: { type: "string" }, description: "Recipient emails or names to set for To" },
            cc: { type: "array", items: { type: "string" }, description: "Recipient emails or names to set for Cc" },
            bcc: { type: "array", items: { type: "string" }, description: "Recipient emails or names to set for Bcc" },
            // granular updates
            toAdd: { type: "array", items: { type: "string" } },
            ccAdd: { type: "array", items: { type: "string" } },
            bccAdd: { type: "array", items: { type: "string" } },
            toRemove: { type: "array", items: { type: "string" } },
            ccRemove: { type: "array", items: { type: "string" } },
            bccRemove: { type: "array", items: { type: "string" } }
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
          "Context: Current page URL is: " + (currentUrl || "unknown") + "\n" +
          "If the current page is Gmail (mail.google.com), treat bare ordinal phrases like 'open first', 'open the 2nd', 'open third' as requests to open an email: use command='open_email' with args.index accordingly, even if the word 'email' is omitted.\n" +
          "If on Gmail, map folder/category navigation like 'open inbox', 'go to spam', 'open drafts', 'open sent', 'open important', 'open starred', 'open all mail', 'open bin/trash', 'open snoozed', 'open scheduled', or 'open promotions/social/updates/forums' to command='open_gmail_section' with args.section being a short token (e.g., 'inbox','spam','drafts','sent','important','starred','all','trash','snoozed','scheduled','promotions','social','updates','forums').\n" +
          "If on Gmail and the user says 'reply', map to command='gmail_reply' with args.mode='reply'. For 'reply all' use args.mode='reply_all'. Accept variants like 'reply to this', 'respond', 'answer', 'reply to this email'.\n" +
          "If on Gmail and the user says 'forward', map to command='gmail_forward'. Extract recipients: 'to' and optional 'cc'/'bcc' as arrays of strings (emails or names). Example: 'forward this to alice@example.com and bob, cc charlie' → {command:'gmail_forward', args:{to:['alice@example.com','bob'], cc:['charlie']}}.\n" +
          "For modifying recipients in the current compose, use command='gmail_update_recipients' with arrays toAdd/ccAdd/bccAdd and toRemove/ccRemove/bccRemove. Example: 'add john to cc and remove bob from to' → {command:'gmail_update_recipients', args:{ccAdd:['john'], toRemove:['bob']}}.\n" +
          "For sending the current compose, use command='gmail_send'. Only trigger when the user clearly says 'send', 'send it now', or equivalent.\n" +
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
          "For summarize: command='summarize', args.target is 'auto' unless user says selection/email/page.\n" +
          "For rewrite_selection: command='rewrite_selection'. args.tone is free-form; if missing, assume 'natural'. Return ONLY the rewritten text.\n" +
          
          "For translating the current page: use command='translate_page'. If the user specifies a language, put it in args.lang (ISO code like 'es' or a language name like 'spanish'). If unspecified, omit args.lang and the app will use a default.\n" +
          "For type_text: command='type_text'. args.text is the text to type; args.target is the target field (e.g., 'search', 'email', or free-form); args.submit=true to press Enter/submit after typing. Map phrases like \"type/enter/fill ...\" to command='type_text'. Put the literal text into args.text. Put a short target hint in args.target (e.g., \"search\", \"email\", \"subject\", \"name\", or a brief noun phrase). Set args.submit=true only if the user explicitly asks to submit or press enter.\n" +
          "For on-page verbs like \"go to/open/select/choose/activate …\", map to click_ui with args.text as the target label. For \"focus …/put cursor in …\", map to focus_ui with args.text as the target label.\n" +
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
          "For natural language questions about the current page (e.g., \"What are the dimensions?\", \"Who is the author?\", \"When was this posted?\"), use command='ask_page' with args.question containing the user's exact question." +
          "For opening emails in Gmail: use command='open_email'. Interpret ordinal expressions with AI and convert to 1-based integers for args.index. Support forms like 'first/second/third', numeric ordinals like '1st/2nd/3rd/10th', and spelled numbers including compounds like 'twenty first'. Examples: 'open first email' → args.index=1; 'open the 3rd email' → args.index=3. Support sender filters like 'open email from alice' → args.sender='alice'. Support subject filters like 'open email about meeting' → args.subject='meeting'. These can combine: 'open first email from bob' → args.index=1, args.sender='bob'."
      },
      { role: "user", content: "User request: " + commandText }
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

  setCurrentCommand(commandText);
  appendTranscript(describePlanned(parsed));

  // Intercepts that run IN THE POPUP (not background)
    if (parsed.command === "summarize") {
      const target = parsed.args?.target || "auto";
      await handleSummarizeFromPopup(target);
      setThinking(false); return;
    }
    // Guard: clicking disabled for now
    if (parsed.command === "click_ui") {
      appendTranscript("ℹ️ Click is disabled right now.");
      setThinking(false); return;
    }
    if (parsed.command === "rewrite_selection") {
      const tone = (parsed.args?.tone || "natural").trim();
      await handleRewriteSelectionFromPopup(tone);
      setThinking(false); return;
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
      appendTranscript("ℹ️ Converted to type-only (no explicit search verb).");
    }

    // Send the rest to executor (background)
    // For Gmail email opening, include the raw utterance to allow precise ordinal parsing on the page.
    if (parsed.command === "open_email") {
      parsed.args = { ...(parsed.args || {}), rawUtterance: commandText };
    }
    chrome.runtime.sendMessage(
      { type: "executeCommand", data: parsed },
      (response) => {
        console.log("Executor response:", response);
        appendTranscript(renderExecution(parsed, response));
        setThinking(false);
      }
    );
  } catch (err) {
    appendTranscript("❌ AI error: " + err.message);
    setThinking(false);
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

// (Email draft feature removed)

// ===== Speech Recognition (accuracy-focused)
function initRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    setStatus("SpeechRecognition not supported in this browser.");
    btn && (btn.disabled = true);
    return;
  }

  recognition = new SpeechRecognition();
  recognition.lang = "en-US";
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
    if (listening) {
      // small cooldown to prevent immediate re-capture of trailing audio
      setTimeout(() => { try { recognition.start(); } catch (_) {} }, RESTART_COOLDOWN_MS);
    }
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

  const sens = 1; // moderate default
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

// No language/sensitivity UI: fixed defaults are used

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

  // remove common fillers at boundaries or isolated (keep 'like' to preserve meaning)
  t = t.replace(/\b(um+|uh+|er+|ah+)\b\s*/gi, "");

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

// ---- Friendly UI messages ----
function describePlanned(cmd) {
  if (!cmd || !cmd.command) return "🤖 Couldn't understand the request.";
  const c = cmd.command;
  const a = cmd.args || {};
  switch (c) {
    case "open_tab":
      return a.url ? `🔗 Will open: ${a.url}` : "🆕 Will open a new tab";
    case "scroll":
      return `🖱️ Will scroll ${a.direction === 'up' ? 'up' : 'down'}`;
    case "scroll_bottom":
      return "🖱️ Will go to the bottom";
    case "scroll_top":
      return "🖱️ Will go to the top";
    case "search_web":
      return a.query ? `🌐 Will search: ${a.query}` : "🌐 Will search the web";
    case "type_text": {
      const tgt = a.target ? ` into ${a.target}` : "";
      const sub = a.submit ? ", then submit" : "";
      return `⌨️ Will type "${a.text || ''}"${tgt}${sub}`;
    }
    case "focus_ui":
      return `🎯 Will focus “${a.text || ''}”`;
    case "go_back":
      return "↩️ Will go back";
    case "refresh":
      return "🔄 Will refresh the page";
    case "go_forward":
      return "↪️ Will go forward";
    case "close_tab":
      return "❌ Will close this tab";
    case "next_tab":
      return "➡️ Will switch to next tab";
    case "previous_tab":
      return "⬅️ Will switch to previous tab";
    case "open_window":
      return "🪟 Will open a new window";
    case "window_fullscreen_on":
      return "🖥️ Will enter fullscreen";
    case "window_fullscreen_off":
      return "🖥️ Will exit fullscreen";
    case "pop_tab_to_window":
      return "🪟 Will pop this tab into a new window";
    case "ask_page":
      return `❓ Will answer: ${a.question || ''}`;
    case "translate_page":
      return `🌍 Will translate this page${a.lang ? ` to ${a.lang}` : " (default language)"}`;
    case "open_email": {
      let desc = "📧 Will open email";
      if (a.index) desc += ` #${a.index}`;
      if (a.sender) desc += ` from ${a.sender}`;
      if (a.subject) desc += ` about ${a.subject}`;
      return desc;
    }
    case "open_gmail_section":
      return `📂 Will open Gmail: ${a.section || ''}`;
    case "gmail_reply":
      return `📧 Will ${a.mode === 'reply_all' ? 'reply all' : 'reply'} to this email`;
    case "gmail_forward": {
      const parts = [];
      if (Array.isArray(a.to) && a.to.length) parts.push(`to ${a.to.join(', ')}`);
      if (Array.isArray(a.cc) && a.cc.length) parts.push(`cc ${a.cc.join(', ')}`);
      if (Array.isArray(a.bcc) && a.bcc.length) parts.push(`bcc ${a.bcc.join(', ')}`);
      return `📨 Will forward this email${parts.length ? ' ' + parts.join('; ') : ''}`;
    }
    case "gmail_update_recipients": {
      const ops = [];
      const addPart = (label, arr) => { if (Array.isArray(arr) && arr.length) ops.push(`add ${arr.join(', ')} to ${label}`); };
      const remPart = (label, arr) => { if (Array.isArray(arr) && arr.length) ops.push(`remove ${arr.join(', ')} from ${label}`); };
      addPart('to', a.toAdd); addPart('cc', a.ccAdd); addPart('bcc', a.bccAdd);
      remPart('to', a.toRemove); remPart('cc', a.ccRemove); remPart('bcc', a.bccRemove);
      return ops.length ? `👥 Will ${ops.join('; ')}` : '👥 Will update recipients';
    }
    case "gmail_send":
      return "🚀 Will send the current email";
    case "summarize":
      return `📝 Will summarize (${a.target || 'auto'})`;
    case "rewrite_selection":
      return `✍️ Will rewrite selection (${a.tone || 'natural'})`;
    
    default:
      return `🤖 Planned: ${c}`;
  }
}

function renderExecution(cmd, res) {
  if (!res) return "⚠️ No response";
  if (res.status === "noop") return "⚠️ Unsupported command";
  if (res.status !== "ok") return `❌ ${res.message || 'Execution failed'}`;

  const c = cmd?.command;
  const info = res.action ? `(${res.action})` : "";
  switch (c) {
    case "open_tab":
      return `✅ Opened ${res.url || 'a tab'} ${info}`;
    case "scroll":
      return `✅ Scrolled ${res.direction || ''}`;
    case "scroll_top":
      return "✅ Went to top";
    case "scroll_bottom":
      return "✅ Went to bottom";
    case "search_web":
      return `✅ Searched: ${cmd?.args?.query || ''}`;
    case "type_text":
      return `✅ Typed${res.info?.submitted ? ' and submitted' : ''}`;
    case "focus_ui":
      return `✅ Focused ${res.label ? `“${res.label}”` : ''}`;
    case "go_back":
      return "✅ Went back";
    case "refresh":
      return "✅ Refreshed";
    case "go_forward":
      return "✅ Went forward";
    case "close_tab":
      return "✅ Closed tab";
    case "next_tab":
      return "✅ Next tab";
    case "previous_tab":
      return "✅ Previous tab";
    case "open_window":
      return "✅ Opened new window";
    case "window_fullscreen_on":
      return "✅ Fullscreen on";
    case "window_fullscreen_off":
      return "✅ Fullscreen off";
    case "pop_tab_to_window":
      return "✅ Tab popped to window";
    case "ask_page":
      return res.answer ? `💬 ${res.answer}` : "✅ Answered";
    case "translate_page":
      return `✅ Opened translated page${res.lang ? ` (${res.lang})` : ''}`;
    case "open_email":
      return res.subject ? `✅ Opened: ${res.subject}` : "✅ Opened email";
    case "open_gmail_section":
      return `✅ Opened Gmail: ${cmd?.args?.section || ''}`;
    case "gmail_reply":
      return `✅ Opened ${cmd?.args?.mode === 'reply_all' ? 'Reply all' : 'Reply'} composer`;
    case "gmail_forward":
      return "✅ Opened Forward composer";
    case "gmail_update_recipients":
      return "✅ Updated recipients";
    case "gmail_send":
      return "✅ Sent email";
    default:
      return `✅ Executed ${info}`;
  }
}
