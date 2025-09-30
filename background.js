// Central dispatcher (Step 2 + Step 3.1 + Step 3.2)

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "executeCommand") return;

  const data = msg.data || {};
  const command = (data.command || "").toLowerCase();
  const args = data.args || {};

  switch (command) {
    case "open_tab": {
      const url = args?.url;
      if (!url) {
        sendResponse({ status: "error", message: "Missing url" });
        break;
      }
      chrome.tabs.create({ url });
      sendResponse({ status: "ok", action: "opened_tab", url });
      break;
    }

    case "scroll": {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tabId = tabs?.[0]?.id;
        if (!tabId) {
          sendResponse({ status: "error", message: "No active tab found" });
          return;
        }
        const direction = args?.direction === "up" ? "up" : "down";
        chrome.scripting.executeScript(
          {
            target: { tabId },
            args: [direction],
            func: (dir) => {
              const amount = window.innerHeight;
              const target =
                document.scrollingElement ||
                document.body ||
                document.documentElement;

              if (dir === "up") {
                target.scrollBy(0, -amount);
              } else {
                target.scrollBy(0, amount);
              }
            }
          },
          () => {
            sendResponse({ status: "ok", action: "scrolled", direction });
          }
        );
      });
      return true; // async
    }

    case "search_web": {
      const query = args?.query?.trim();
      if (!query) {
        sendResponse({ status: "error", message: "Missing query" });
        break;
      }

      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tabId = tabs?.[0]?.id;
        if (!tabId) {
          sendResponse({ status: "error", message: "No active tab found" });
          return;
        }

        // Try site search first. If not possible, fall back to Google.
        chrome.scripting.executeScript(
          {
            target: { tabId },
            args: [query],
            func: (q) => {
              const visible = (el) => !!(el && el.offsetParent !== null && !el.disabled);

              const selectors = [
                'input[type="search"]',
                'input[role="searchbox"]',
                'input[name*="search" i]',
                'input[id*="search" i]',
                'input[aria-label*="search" i]',
                'input[placeholder*="search" i]',
                '[role="search"] input',
                'textarea[role="searchbox"]'
              ];

              let input =
                Array.from(document.querySelectorAll(selectors.join(","))).find(visible) ||
                Array.from(document.querySelectorAll('input[type="text"]')).find(
                  (el) =>
                    visible(el) &&
                    /search|find/i.test(
                      (el.placeholder || "") +
                        " " +
                        (el.getAttribute("aria-label") || "") +
                        " " +
                        (el.name || "") +
                        " " +
                        (el.id || "")
                    )
                );

              if (!input) return { success: false, reason: "no_input" };

              // Set value in a way frameworks detect
              const proto = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype,
                "value"
              );
              proto?.set?.call(input, q);
              input.dispatchEvent(new Event("input", { bubbles: true }));
              input.dispatchEvent(new Event("change", { bubbles: true }));

              // Submit via form if available
              let form = input.form || input.closest("form");
              if (form && typeof form.submit === "function") {
                form.submit();
                return { success: true, method: "form" };
              }

              // Try click a submit/search button
              const btn =
                input
                  .closest("form")
                  ?.querySelector('button[type="submit"], input[type="submit"]') ||
                document.querySelector(
                  'button[aria-label*="search" i], button[type="submit"], input[type="submit"]'
                );

              if (btn) {
                btn.click();
                return { success: true, method: "button" };
              }

              // Simulate Enter key
              const press = (type) =>
                input.dispatchEvent(
                  new KeyboardEvent(type, {
                    key: "Enter",
                    keyCode: 13,
                    which: 13,
                    bubbles: true
                  })
                );
              press("keydown");
              press("keypress");
              press("keyup");
              return { success: true, method: "enter" };
            }
          },
          (results) => {
            const ok = Array.isArray(results) && results[0]?.result?.success;
            if (ok) {
              sendResponse({ status: "ok", action: "search_in_page", query });
            } else {
              const google =
                "https://www.google.com/search?q=" + encodeURIComponent(query);
              chrome.tabs.create({ url: google });
              sendResponse({
                status: "ok",
                action: "search_google_fallback",
                query
              });
            }
          }
        );
      });
      return true; // async
    }

    case "click_ui": {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tabId = tabs?.[0]?.id;
        const text = args?.text || "";
        if (!tabId || !text) {
          sendResponse({ status: "error", message: "Missing text or no active tab" });
          return;
        }
        runUiTargeting(tabId, "click", text, sendResponse);
      });
      return true; // async
    }

    case "focus_ui": {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tabId = tabs?.[0]?.id;
        const text = args?.text || "";
        if (!tabId || !text) {
          sendResponse({ status: "error", message: "Missing text or no active tab" });
          return;
        }
        runUiTargeting(tabId, "focus", text, sendResponse);
      });
      return true; // async
    }

    case "type_text": {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tabId = tabs?.[0]?.id;
        const text = args?.text;
        const targetHint = (args?.target || "auto").toLowerCase();
        const submit = !!args?.submit;

        if (!tabId || !text) {
          sendResponse({ status: "error", message: "Missing text or no active tab" });
          return;
        }

        chrome.scripting.executeScript(
          {
            target: { tabId },
            args: [text, targetHint, submit],
            func: (valueToType, hint, doSubmit) => {
              // ---------- helpers
              const norm = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();
              const visible = (el) => {
                if (!el) return false;
                const cs = getComputedStyle(el);
                if (cs.visibility === "hidden" || cs.display === "none" || el.hidden) return false;
                const r = el.getBoundingClientRect();
                return r.width > 1 && r.height > 1;
              };
              const inViewport = (el) => {
                const r = el.getBoundingClientRect();
                const h = window.innerHeight || document.documentElement.clientHeight;
                const w = window.innerWidth || document.documentElement.clientWidth;
                return r.bottom > 0 && r.right > 0 && r.top < h && r.left < w;
              };
              const labelFor = (el) => {
                // collect label-like strings around the element
                const id = el.getAttribute?.("id");
                let lbl = "";
                if (id) {
                  const l = document.querySelector(`label[for=\"${CSS.escape(id)}\"]`);
                  if (l && l.innerText) lbl = l.innerText;
                }
                if (!lbl) lbl = el.getAttribute?.("aria-label") || "";
                if (!lbl) lbl = el.getAttribute?.("placeholder") || "";
                if (!lbl && el.name) lbl = el.name;
                if (!lbl && el.id) lbl = el.id;
                // try parent label wrapper
                if (!lbl && el.closest) {
                  const wrap = el.closest("label");
                  if (wrap && wrap.innerText) lbl = wrap.innerText;
                }
                return (lbl || "").trim();
              };
              const isEditable = (el) => {
                if (!el) return false;
                if (el.isContentEditable) return true;
                if (el.tagName === "TEXTAREA") return true;
                if (el.tagName === "INPUT") {
                  const t = (el.type || "text").toLowerCase();
                  return ["text","search","email","tel","url","number"].includes(t);
                }
                return false;
              };

              // choose candidates
              const selector = [
                "input[type='text']",
                "input[type='search']",
                "input[type='email']",
                "input[type='tel']",
                "input[type='url']",
                "input:not([type])",         // text by default
                "textarea",
                "[role='searchbox']",
                "[contenteditable='true']",
                "[contenteditable]"
              ].join(",");

              // If something focused and editable, prefer it
              const active = document.activeElement;
              if (isEditable(active) && visible(active)) {
                // ok, use focused one
              } else {
                // try to focus the page so .focus() works
                window.focus?.();
              }

              const all = Array.from(document.querySelectorAll(selector)).filter((el) => isEditable(el) && visible(el));

              // Password safety: never touch password unless explicitly asked
              const isPasswordIntent = /\bpassword\b/i.test(hint);
              const filterPassword = (el) => {
                return !(el.tagName === "INPUT" && (el.type || "").toLowerCase() === "password" && !isPasswordIntent);
              };

              const candidates = all.filter(filterPassword);

              // scoring
              const score = (el) => {
                let s = 0;
                // focus boost
                if (el === active) s += 50;
                // viewport boost
                if (inViewport(el)) s += 10;

                const lab = labelFor(el);
                const labN = norm(lab);
                const hintN = norm(hint);

                // category boosts by hint
                const t = (el.type || "").toLowerCase();
                if (/^(search|query)$/.test(hintN)) {
                  if (t === "search" || el.getAttribute("role") === "searchbox") s += 40;
                  if (/search|query|find/i.test(lab)) s += 25;
                }
                if (/email|e-mail/i.test(hintN)) {
                  if (t === "email") s += 40;
                  if (/email/i.test(lab)) s += 25;
                }
                if (/subject/i.test(hintN)) {
                  if (/subject/i.test(lab)) s += 40;
                }
                if (/name|full name|first name|last name/i.test(hintN)) {
                  if (/name|first|last/i.test(lab)) s += 25;
                }

                // free-form overlap
                if (hintN && labN) {
                  const hWords = new Set(hintN.split(" ").filter(Boolean));
                  const lWords = new Set(labN.split(" ").filter(Boolean));
                  let overlap = 0;
                  hWords.forEach((w) => { if (lWords.has(w)) overlap++; });
                  s += Math.min(30, overlap * 10);
                }

                // prefer obvious search bars even with no hint
                if (hintN === "auto") {
                  if (t === "search" || el.getAttribute("role") === "searchbox" || /search/i.test(lab)) s += 15;
                }

                // size/position heuristics
                try {
                  const r = el.getBoundingClientRect();
                  s += Math.min(20, Math.round((r.width * r.height) / 2000));
                  if (r.top < window.innerHeight * 0.6) s += 5; // upper 60%
                } catch (_) {}

                return s;
              };

              // pick best element
              let target = null;
              if (isEditable(active) && visible(active)) {
                target = active;
              } else {
                let best = null, bestScore = -1;
                for (const el of candidates) {
                  const sc = score(el);
                  if (sc > bestScore) { best = el; bestScore = sc; }
                }
                target = best;
              }

              if (!target) return { success: false, reason: "no_input_found" };

              // focus and set value (framework-friendly)
              target.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
              target.focus({ preventScroll: true });

              // highlight briefly
              const prevOutline = target.style.outline;
              target.style.outline = "2px solid #22d3ee";
              setTimeout(() => (target.style.outline = prevOutline || ""), 800);

              // setter path for inputs/textarea
              const fire = (el) => {
                el.dispatchEvent(new Event("input", { bubbles: true }));
                el.dispatchEvent(new Event("change", { bubbles: true }));
              };

              if (target.isContentEditable) {
                target.innerText = valueToType;
                fire(target);
              } else if (target.tagName === "TEXTAREA" || target.tagName === "INPUT") {
                const proto = target.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                const desc = Object.getOwnPropertyDescriptor(proto, "value");
                desc?.set?.call(target, valueToType);
                fire(target);
              } else if (target.getAttribute("role") === "searchbox") {
                target.textContent = valueToType;
                fire(target);
              } else {
                return { success: false, reason: "unsupported_target_type" };
              }

              // optional submit
              if (doSubmit) {
                const form = target.form || target.closest?.("form");
                // prefer form submission if present
                if (form && typeof form.requestSubmit === "function") {
                  form.requestSubmit();
                } else {
                  // simulate Enter
                  const press = (type) => target.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 }));
                  press("keydown"); press("keypress"); press("keyup");
                }
              }

              return {
                success: true,
                where: target.isContentEditable ? "contenteditable"
                  : (target.tagName === "TEXTAREA" ? "textarea" : (target.tagName === "INPUT" ? `input:${(target.type||'text').toLowerCase()}` : "searchbox")),
                submitted: !!doSubmit
              };
            }
          },
          (results) => {
            const res = results?.[0]?.result;
            if (res?.success) {
              sendResponse({ status: "ok", action: "typed", info: res });
            } else {
              sendResponse({ status: "error", message: "No input matched", info: res });
            }
          }
        );
      });
      return true; // async
    }

    case "go_back": {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tabId = tabs?.[0]?.id;
        if (!tabId) {
          sendResponse({ status: "error", message: "No active tab found" });
          return;
        }
        chrome.tabs.goBack(tabId, () => {
          if (chrome.runtime.lastError) {
            // Fallback: history.back() inside the page
            chrome.scripting.executeScript(
              {
                target: { tabId },
                func: () => {
                  try { window.history.back(); return { ok: true }; }
                  catch { return { ok: false }; }
                }
              },
              (results) => {
                if (results?.[0]?.result?.ok) {
                  sendResponse({ status: "ok", action: "went_back" });
                } else {
                  sendResponse({ status: "error", message: "no_previous_history" });
                }
              }
            );
          } else {
            sendResponse({ status: "ok", action: "went_back" });
          }
        });
      });
      return true; // async
    }

    case "refresh": {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tabId = tabs?.[0]?.id;
        if (!tabId) {
          sendResponse({ status: "error", message: "No active tab found" });
          return;
        }
        chrome.tabs.reload(tabId, { bypassCache: false }, () => {
          if (chrome.runtime.lastError) {
            sendResponse({ status: "error", message: chrome.runtime.lastError.message });
          } else {
            sendResponse({ status: "ok", action: "refreshed" });
          }
        });
      });
      return true; // async
    }

    case "go_forward": {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tabId = tabs?.[0]?.id;
        if (!tabId) {
          sendResponse({ status: "error", message: "No active tab found" });
          return;
        }
        chrome.tabs.goForward(tabId, () => {
          if (chrome.runtime.lastError) {
            // Fallback: history.forward() inside the page
            chrome.scripting.executeScript(
              {
                target: { tabId },
                func: () => {
                  try { window.history.forward(); return { ok: true }; }
                  catch { return { ok: false }; }
                }
              },
              (results) => {
                if (results?.[0]?.result?.ok) {
                  sendResponse({ status: "ok", action: "went_forward" });
                } else {
                  sendResponse({ status: "error", message: "no_forward_history" });
                }
              }
            );
          } else {
            sendResponse({ status: "ok", action: "went_forward" });
          }
        });
      });
      return true; // async
    }

    default:
      sendResponse({ status: "noop", message: `Unsupported command: ${command}` });
  }
});

// ---- 3.5: shared injected function for targeting/click/focus
function runUiTargeting(tabId, action, rawText, sendResponse) {
  chrome.scripting.executeScript(
    {
      target: { tabId },
      args: [action, rawText],
      func: (action, rawText) => {
        // ===== Helpers (run in page) =====
        const now = Date.now();

        function normalize(s){ return (s||"").toLowerCase().replace(/\s+/g," ").trim(); }
        function visible(el){
          if(!el) return false;
          const cs = getComputedStyle(el);
          if(cs.visibility==="hidden"||cs.display==="none"||el.hidden) return false;
          const r = el.getBoundingClientRect();
          return r.width>1 && r.height>1;
        }
        function inViewport(el){
          const r = el.getBoundingClientRect();
          const h = innerHeight||document.documentElement.clientHeight;
          const w = innerWidth||document.documentElement.clientWidth;
          return r.bottom>0 && r.right>0 && r.top<h && r.left<w;
        }
        function a11yName(el){
          const aria = el.getAttribute?.("aria-label");
          if(aria) return aria;
          const labelledby = el.getAttribute?.("aria-labelledby");
          if(labelledby){
            const t = labelledby.split(/\s+/).map(id=>document.getElementById(id)?.innerText||"").join(" ").trim();
            if(t) return t;
          }
          const title = el.getAttribute?.("title"); if(title) return title;
          const val = (el.value ?? el.getAttribute?.("value") ?? ""); if(val) return val;
          const alt = el.getAttribute?.("alt"); if(alt) return alt;
          // innerText last (expensive)
          return (el.innerText||"").trim();
        }
        function synonymBoost(q, label){
          const qn = normalize(q), ln = normalize(label);
          const syn = [
            ["cart","basket","bag","trolley"],
            ["review","reviews","rating","ratings","stars"],
            ["login","log in","sign in","signin"],
            ["logout","log out","sign out","signout"],
            ["search","find","query"],
            ["spam","junk"],
            ["inbox","primary"]
          ];
          let bonus = 0;
          for(const group of syn){
            if(group.some(w=>qn.includes(w)) && group.some(w=>ln.includes(w))){
              bonus += 20; break;
            }
          }
          return bonus;
        }
        function scoreLabel(query, label, el){
          const q = normalize(query), l = normalize(label);
          if(!q || !l) return 0;
          let s = 0;
          if(l===q) s += 100;
          if(l.startsWith(q)) s += 80;
          if(l.includes(q)) s += 60;
          // token overlap
          const qW = new Set(q.split(" ").filter(Boolean));
          const lW = new Set(l.split(" ").filter(Boolean));
          let overlap = 0;
          qW.forEach(w=>{ if(lW.has(w)) overlap++; });
          s += Math.min(40, overlap*12);
          s += synonymBoost(q, label);
          if(inViewport(el)) s += 12; else s -= 10;
          const role = el.getAttribute?.("role")||"";
          const tag = el.tagName?.toLowerCase()||"";
          if(tag==="a"||role==="link") s += 5;
          if(tag==="button"||role==="button") s += 3;
          try{
            const r = el.getBoundingClientRect();
            s += Math.min(20, Math.round((r.width*r.height)/2000));
          }catch(_){}
          return s;
        }

        // ===== Build/update a small index (cached briefly) =====
        const TTL = 2500; // ms
        const cache = (window.__lazycatIndex ||= { t:0, nodes:[] });
        if (now - cache.t > TTL){
          // (re)scan
          const nodes = [];
          const addFromRoot = (root) => {
            const selector = [
              "button","a","[role='button']","[role='link']",
              "[aria-label]","[title]","summary","[tabindex]",
              "input","textarea","[contenteditable='true']","[contenteditable]"
            ].join(",");
            const els = root.querySelectorAll(selector);
            for(const el of els){
              if(!visible(el)) continue;
              nodes.push(el);
            }
          };
          addFromRoot(document);
          // pierce shallow shadow roots
          const allEls = document.querySelectorAll("*");
          for (const host of allEls){
            const sr = host.shadowRoot;
            if (sr) {
              try { addFromRoot(sr); } catch(_){}
            }
          }
          cache.nodes = nodes.slice(0, 3000); // safety cap
          cache.t = now;
        }

        // ===== Disambiguation overlay =====
        function showOverlay(options){
          // remove existing
          const old = document.getElementById("__lazycat_overlay");
          if(old) old.remove();

          const box = document.createElement("div");
          box.id="__lazycat_overlay";
          box.style.cssText = `
            position:fixed; top:12px; right:12px; z-index:2147483647;
            background:#0b1220; color:#e5f2ff; border:1px solid #22d3ee;
            border-radius:10px; padding:10px 12px; font:13px/1.4 system-ui, -apple-system, Segoe UI, Roboto;
            box-shadow:0 10px 30px rgba(0,0,0,.35); max-width:280px;
          `;
          const title = document.createElement("div");
          title.textContent = "Which one?";
          title.style.cssText = "font-weight:600; margin-bottom:6px;";
          box.appendChild(title);

          options.forEach((opt, i)=>{
            const item = document.createElement("button");
            item.type="button";
            item.style.cssText = `
              display:block; width:100%; text-align:left; margin:6px 0; padding:6px 8px;
              background:#0f172a; color:#e5f2ff; border:1px solid #1f2a44; border-radius:8px; cursor:pointer;
            `;
            item.innerHTML = `<strong>${i+1}.</strong> ${opt.label}`;
            item.onmouseenter = ()=>{ opt.el.style.outline="2px solid #22d3ee"; opt.el.scrollIntoView({behavior:"smooth",block:"center"}); };
            item.onmouseleave = ()=>{ opt.el.style.outline=""; };
            item.onclick = ()=>{
              box.remove();
              actOn(opt.el);
            };
            box.appendChild(item);
          });

          const close = document.createElement("div");
          close.textContent = "Esc to dismiss";
          close.style.cssText = "opacity:.7; margin-top:6px; font-size:12px;";
          box.appendChild(close);

          document.body.appendChild(box);
          const onKey = (e)=>{ if(e.key==="Escape"){ box.remove(); window.removeEventListener("keydown", onKey); } };
          window.addEventListener("keydown", onKey);
        }

        // ===== Action on an element =====
        function highlight(el){
          const prev = el.style.outline;
          el.style.outline="3px solid #22d3ee";
          setTimeout(()=>{ el.style.outline = prev || ""; }, 600);
        }
        function actOn(el){
          el.scrollIntoView({behavior:"smooth", block:"center", inline:"center"});
          highlight(el);
          if(action === "focus"){
            if (el.focus) el.focus({ preventScroll:true });
            return { success:true, action:"focused", label:a11yName(el) };
          } else {
            try { el.click(); return { success:true, action:"clicked", label:a11yName(el) }; }
            catch(e){ return { success:false, reason:"click_failed" }; }
          }
        }

        // ===== Main selection logic =====
        // Clean the incoming phrase (“go to/open …” → target noun-ish)
        let cleaned = normalize(rawText).replace(/\b(go to|open|select|choose|activate|click|press|tap|the|a|an|this|that|email|link|button|tab|folder|section|page)\b/g,"").trim();
        if (!cleaned) cleaned = normalize(rawText);

        // Rank candidates
        let bests = [];
        for(const el of window.__lazycatIndex.nodes){
          const label = a11yName(el);
          if(!label) continue;
          const sc = scoreLabel(cleaned, label, el);
          if (sc <= 0) continue;
          bests.push({ el, label, score: sc });
        }
        bests.sort((a,b)=>b.score - a.score);

        if (!bests.length || bests[0].score < 30) {
          return { success:false, reason:"not_found", cleaned };
        }

        // If close competitors exist, ask user to choose up to 3
        const top = bests[0].score;
        const choices = bests.filter(x=>x.score >= top*0.8).slice(0,3);

        if (choices.length > 1) {
          // show overlay & defer the click/focus to user click
          showOverlay(choices);
          return {
            success:false,
            reason:"disambiguation",
            options: choices.map((c,i)=>({ index:i+1, label:c.label, score:c.score }))
          };
        }

        // Single confident match → act
        return actOn(bests[0].el);
      }
    },
    (injectionResults) => {
      const res = injectionResults?.[0]?.result;
      if (res?.success) {
        sendResponse({ status:"ok", action: res.action, label: res.label });
      } else {
        sendResponse({ status:"error", message: res?.reason || "failed", info: res });
      }
    }
  );
}
