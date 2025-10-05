// Central dispatcher (Step 2 + Step 3.1 + Step 3.2)

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "executeCommand") return;

  const data = msg.data || {};
  const command = (data.command || "").toLowerCase();
  const args = data.args || {};

  switch (command) {
    case "open_tab": {
      let url = args?.url && args.url.trim();

      if (url && !/^https?:\/\//i.test(url)) {
        // Auto-fix bare domains/words
        url = `https://${url.replace(/\s+/g, "")}.com`;
      }

      chrome.tabs.create(
        url ? { url } : {}, // blank if still nothing
        (tab) => {
          sendResponse({
            status: "ok",
            action: url ? "opened_tab_with_url" : "opened_blank_tab",
            tabId: tab.id,
            url: tab.url || "about:blank"
          });
        }
      );
      return true;
    }

    case "scroll": {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs?.[0];
        const tabId = tab?.id;
        if (!tabId) {
          sendResponse({ status: "error", message: "No active tab found" });
          return;
        }
        
        // Check if we're on Gmail
        let isGmail = false;
        try {
          const u = new URL(tab.url || "");
          isGmail = /(^|\.)mail\.google\.com$/i.test(u.host) || /gmail/i.test(u.host);
        } catch (_) {}
        
        const direction = args?.direction === "up" ? "up" : "down";
        chrome.scripting.executeScript(
          {
            target: { tabId },
            args: [direction, isGmail],
            func: (dir, isGmail) => {
              const amount = window.innerHeight * 0.8; // Scroll 80% of viewport
              
              const findScrollableTarget = () => {
                if (isGmail) {
                  // Gmail-specific scrollable containers
                  const gmailSelectors = [
                    'div[role="main"]', // Main content area
                    'div.aeN', // Gmail conversation list
                    'div[gh="tl"]', // Gmail thread list
                    'div.Tm.aeJ', // Gmail email list container
                    'div[data-thread-id]', // Thread container
                    '.nH.oy8Mbf', // Gmail scrollable pane
                    'div[role="listbox"]', // Gmail list container
                    'div.ae4.UI' // Gmail main view
                  ];
                  
                  for (const sel of gmailSelectors) {
                    const el = document.querySelector(sel);
                    if (el && el.scrollHeight > el.clientHeight) {
                      return el;
                    }
                  }
                  
                  // Look for any scrollable div in Gmail
                  const scrollableEls = Array.from(document.querySelectorAll('div'))
                    .filter(el => {
                      const style = getComputedStyle(el);
                      return (style.overflow === 'auto' || style.overflow === 'scroll' || style.overflowY === 'auto' || style.overflowY === 'scroll') &&
                             el.scrollHeight > el.clientHeight &&
                             el.offsetWidth > 200 && el.offsetHeight > 200; // Reasonable size
                    })
                    .sort((a, b) => (b.scrollHeight * b.clientHeight) - (a.scrollHeight * a.clientHeight)); // Prefer larger scrollable areas
                  
                  if (scrollableEls.length > 0) {
                    return scrollableEls[0];
                  }
                }
                
                // Fallback to document scrolling
                return document.scrollingElement || document.body || document.documentElement;
              };
              
              const target = findScrollableTarget();
              if (!target) return { success: false, reason: 'no_scrollable_target' };
              
              const scrollAmount = dir === "up" ? -amount : amount;
              target.scrollBy({ top: scrollAmount, behavior: "smooth" });
              
              return {
                success: true,
                target: target.tagName + (target.className ? '.' + target.className.split(' ')[0] : ''),
                scrollTop: target.scrollTop,
                scrollHeight: target.scrollHeight
              };
            }
          },
          (results) => {
            const res = results?.[0]?.result;
            if (res?.success) {
              sendResponse({ status: "ok", action: "scrolled", direction, target: res.target });
            } else {
              sendResponse({ status: "error", message: `Scroll failed: ${res?.reason || 'unknown'}` });
            }
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
        const tab = tabs?.[0];
        const tabId = tab?.id;
        if (!tabId) {
          sendResponse({ status: "error", message: "No active tab found" });
          return;
        }
        let isGmail = false;
        try {
          const u = new URL(tab.url || "");
          isGmail = /(^|\.)mail\.google\.com$/i.test(u.host) || /gmail/i.test(u.host);
        } catch (_) {}

        // Try site search first. On Gmail, prefer in-page Enter submission and avoid external fallback.
        chrome.scripting.executeScript(
          {
            target: { tabId },
            args: [query, isGmail],
            func: (q, isGmail) => {
              const visible = (el) => !!(el && el.offsetParent !== null && !el.disabled);
              const isEditable = (el) => {
                if (!el) return false;
                if (el.isContentEditable) return true;
                if (el.tagName === "TEXTAREA") return true;
                if (el.tagName === "INPUT") {
                  const t = (el.type || "text").toLowerCase();
                  return ["text", "search", "email", "tel", "url", "number"].includes(t);
                }
                return false;
              };

              const findTarget = () => {
                // Broad selectors including contenteditable/combobox and common aria labels
                const selectors = [
                  '[role="searchbox"]',
                  '[role="search"] input',
                  'input[type="search"]',
                  'input[aria-label*="search" i]',
                  'input[placeholder*="search" i]',
                  'input[name*="search" i]',
                  'input[id*="search" i]',
                  'textarea[role="searchbox"]',
                  '[contenteditable="true"][aria-label*="search" i]',
                  'div[role="combobox"][aria-label*="search" i]'
                ];

                let cand = Array.from(document.querySelectorAll(selectors.join(","))).filter(visible);
                // Gmail-specific labels
                cand = [
                  ...cand,
                  ...Array.from(document.querySelectorAll('[aria-label*="search in mail" i]')).filter(visible)
                ];

                // Fallback to focused editable
                const active = document.activeElement;
                if (isEditable(active) && visible(active)) cand.unshift(active);

                // Filter to editable elements
                cand = cand.filter(isEditable);

                // Prefer ones inside role=search
                cand.sort((a, b) => {
                  const aIn = a.closest && a.closest('[role="search"]') ? 1 : 0;
                  const bIn = b.closest && b.closest('[role="search"]') ? 1 : 0;
                  return bIn - aIn;
                });

                return cand[0] || null;
              };

              let target = findTarget();

              // On Gmail, try '/' shortcut to focus search if not found
              if (isGmail && !target) {
                const sendSlash = (type) => document.dispatchEvent(new KeyboardEvent(type, { key: '/', code: 'Slash', keyCode: 191, which: 191, bubbles: true, cancelable: true }));
                sendSlash('keydown'); sendSlash('keypress'); sendSlash('keyup');
                // after shortcut, new activeElement may be the search box
                const ae = document.activeElement;
                if (isEditable(ae) && visible(ae)) target = ae;
              }

              if (!target) return { success: false, reason: "no_input" };

              // Focus and set value/text
              target.focus({ preventScroll: true });
              const fire = (el) => {
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              };
              if (target.isContentEditable) {
                target.innerText = q;
                fire(target);
              } else if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') {
                const proto = target.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                const desc = Object.getOwnPropertyDescriptor(proto, 'value');
                desc?.set?.call(target, q);
                fire(target);
              } else {
                target.textContent = q;
                fire(target);
              }

              // Submission behavior
              if (isGmail) {
                // Gmail works with Enter; avoid form.submit to prevent reload
                const press = (type, el) => el.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 }));
                press('keydown', target); press('keypress', target); press('keyup', target);
                return { success: true, method: 'gmail_enter' };
              }

              // Generic: try form submission, then button, then Enter
              const form = target.form || target.closest?.('form');
              if (form && typeof form.requestSubmit === 'function') {
                form.requestSubmit();
                return { success: true, method: 'form_requestSubmit' };
              }
              if (form && typeof form.submit === 'function') {
                form.submit();
                return { success: true, method: 'form_submit' };
              }
              const btn = form?.querySelector('button[type="submit"], input[type="submit"]') || document.querySelector('button[aria-label*="search" i], button[type="submit"], input[type="submit"]');
              if (btn) { btn.click(); return { success: true, method: 'button' }; }
              const press = (type, el) => el.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 }));
              press('keydown', target); press('keypress', target); press('keyup', target);
              return { success: true, method: 'enter' };
            }
          },
          (results) => {
            const res = Array.isArray(results) ? results[0]?.result : null;
            const ok = !!res?.success;
            if (ok) {
              sendResponse({ status: "ok", action: "search_in_page", query, method: res?.method });
            } else {
              if (isGmail) {
                // Do not open Google when on Gmail; report failure so UI knows
                sendResponse({ status: "error", message: "gmail_search_not_found", query });
              } else {
                const google = "https://www.google.com/search?q=" + encodeURIComponent(query);
                chrome.tabs.create({ url: google });
                sendResponse({ status: "ok", action: "search_google_fallback", query });
              }
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

    case "scroll_bottom": {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs?.[0];
        const tabId = tab?.id;
        if (!tabId) {
          sendResponse({ status: "error", message: "No active tab found" });
          return;
        }
        
        // Check if we're on Gmail
        let isGmail = false;
        try {
          const u = new URL(tab.url || "");
          isGmail = /(^|\.)mail\.google\.com$/i.test(u.host) || /gmail/i.test(u.host);
        } catch (_) {}
        
        chrome.scripting.executeScript(
          {
            target: { tabId },
            args: [isGmail],
            func: (isGmail) => {
              const findScrollableTarget = () => {
                if (isGmail) {
                  const gmailSelectors = [
                    'div[role="main"]',
                    'div.aeN',
                    'div[gh="tl"]',
                    'div.Tm.aeJ',
                    'div[data-thread-id]',
                    '.nH.oy8Mbf',
                    'div[role="listbox"]',
                    'div.ae4.UI'
                  ];
                  
                  for (const sel of gmailSelectors) {
                    const el = document.querySelector(sel);
                    if (el && el.scrollHeight > el.clientHeight) {
                      return el;
                    }
                  }
                  
                  const scrollableEls = Array.from(document.querySelectorAll('div'))
                    .filter(el => {
                      const style = getComputedStyle(el);
                      return (style.overflow === 'auto' || style.overflow === 'scroll' || style.overflowY === 'auto' || style.overflowY === 'scroll') &&
                             el.scrollHeight > el.clientHeight &&
                             el.offsetWidth > 200 && el.offsetHeight > 200;
                    })
                    .sort((a, b) => (b.scrollHeight * b.clientHeight) - (a.scrollHeight * a.clientHeight));
                  
                  if (scrollableEls.length > 0) {
                    return scrollableEls[0];
                  }
                }
                
                return document.scrollingElement || document.body || document.documentElement;
              };
              
              const target = findScrollableTarget();
              if (target) {
                target.scrollTo({ top: target.scrollHeight, behavior: "smooth" });
                return { success: true, target: target.tagName };
              }
              return { success: false, reason: 'no_target' };
            }
          },
          (results) => {
            const res = results?.[0]?.result;
            if (res?.success) {
              sendResponse({ status: "ok", action: "scrolled_bottom" });
            } else {
              sendResponse({ status: "error", message: "Scroll to bottom failed" });
            }
          }
        );
      });
      return true;
    }

    case "scroll_top": {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs?.[0];
        const tabId = tab?.id;
        if (!tabId) {
          sendResponse({ status: "error", message: "No active tab found" });
          return;
        }
        
        // Check if we're on Gmail
        let isGmail = false;
        try {
          const u = new URL(tab.url || "");
          isGmail = /(^|\.)mail\.google\.com$/i.test(u.host) || /gmail/i.test(u.host);
        } catch (_) {}
        
        chrome.scripting.executeScript(
          {
            target: { tabId },
            args: [isGmail],
            func: (isGmail) => {
              const findScrollableTarget = () => {
                if (isGmail) {
                  const gmailSelectors = [
                    'div[role="main"]',
                    'div.aeN',
                    'div[gh="tl"]',
                    'div.Tm.aeJ',
                    'div[data-thread-id]',
                    '.nH.oy8Mbf',
                    'div[role="listbox"]',
                    'div.ae4.UI'
                  ];
                  
                  for (const sel of gmailSelectors) {
                    const el = document.querySelector(sel);
                    if (el && el.scrollHeight > el.clientHeight) {
                      return el;
                    }
                  }
                  
                  const scrollableEls = Array.from(document.querySelectorAll('div'))
                    .filter(el => {
                      const style = getComputedStyle(el);
                      return (style.overflow === 'auto' || style.overflow === 'scroll' || style.overflowY === 'auto' || style.overflowY === 'scroll') &&
                             el.scrollHeight > el.clientHeight &&
                             el.offsetWidth > 200 && el.offsetHeight > 200;
                    })
                    .sort((a, b) => (b.scrollHeight * b.clientHeight) - (a.scrollHeight * a.clientHeight));
                  
                  if (scrollableEls.length > 0) {
                    return scrollableEls[0];
                  }
                }
                
                return document.scrollingElement || document.body || document.documentElement;
              };
              
              const target = findScrollableTarget();
              if (target) {
                target.scrollTo({ top: 0, behavior: "smooth" });
                return { success: true, target: target.tagName };
              }
              return { success: false, reason: 'no_target' };
            }
          },
          (results) => {
            const res = results?.[0]?.result;
            if (res?.success) {
              sendResponse({ status: "ok", action: "scrolled_top" });
            } else {
              sendResponse({ status: "error", message: "Scroll to top failed" });
            }
          }
        );
      });
      return true;
    }

    case "close_tab": {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tabId = tabs?.[0]?.id;
        if (!tabId) {
          sendResponse({ status: "error", message: "No active tab found" });
          return;
        }
        chrome.tabs.remove(tabId, () => {
          if (chrome.runtime.lastError) {
            sendResponse({ status: "error", message: chrome.runtime.lastError.message });
          } else {
            sendResponse({ status: "ok", action: "closed_tab", tabId });
          }
        });
      });
      return true; // async
    }

    case "next_tab": {
      chrome.tabs.query({ currentWindow: true }, (tabs) => {
        if (!tabs || !tabs.length) {
          sendResponse({ status: "error", message: "No tabs in window" });
          return;
        }
        const activeTab = tabs.find((t) => t.active);
        if (!activeTab) {
          sendResponse({ status: "error", message: "No active tab found" });
          return;
        }
        const idx = (activeTab.index + 1) % tabs.length;
        chrome.tabs.update(tabs[idx].id, { active: true }, () =>
          sendResponse({ status: "ok", action: "moved_next", tabIndex: idx })
        );
      });
      return true;
    }

    case "previous_tab": {
      chrome.tabs.query({ currentWindow: true }, (tabs) => {
        if (!tabs || !tabs.length) {
          sendResponse({ status: "error", message: "No tabs in window" });
          return;
        }
        const activeTab = tabs.find((t) => t.active);
        if (!activeTab) {
          sendResponse({ status: "error", message: "No active tab found" });
          return;
        }
        const idx = (activeTab.index - 1 + tabs.length) % tabs.length;
        chrome.tabs.update(tabs[idx].id, { active: true }, () =>
          sendResponse({ status: "ok", action: "moved_previous", tabIndex: idx })
        );
      });
      return true;
    }

    case "open_window": {
      chrome.windows.create({}, (win) => {
        if (chrome.runtime.lastError) {
          sendResponse({ status: "error", message: chrome.runtime.lastError.message });
        } else {
          sendResponse({ status: "ok", action: "opened_window", windowId: win.id });
        }
      });
      return true;
    }

    case "window_fullscreen_on": {
      chrome.windows.getCurrent({}, (win) => {
        if (!win) {
          sendResponse({ status: "error", message: "No active window found" });
          return;
        }
        if (win.state === "fullscreen") {
          sendResponse({ status: "ok", action: "already_fullscreen", windowId: win.id });
          return;
        }
        chrome.windows.update(win.id, { state: "fullscreen" }, (updated) => {
          if (chrome.runtime.lastError) {
            sendResponse({ status: "error", message: chrome.runtime.lastError.message });
          } else {
            sendResponse({ status: "ok", action: "window_fullscreen_on", windowId: updated.id });
          }
        });
      });
      return true; // async
    }

    case "window_fullscreen_off": {
      chrome.windows.getCurrent({}, (win) => {
        if (!win) {
          sendResponse({ status: "error", message: "No active window found" });
          return;
        }
        if (win.state !== "fullscreen") {
          sendResponse({ status: "ok", action: "not_fullscreen", windowId: win.id });
          return;
        }
        chrome.windows.update(win.id, { state: "normal" }, (updated) => {
          if (chrome.runtime.lastError) {
            sendResponse({ status: "error", message: chrome.runtime.lastError.message });
          } else {
            sendResponse({ status: "ok", action: "window_fullscreen_off", windowId: updated.id });
          }
        });
      });
      return true; // async
    }

    case "pop_tab_to_window": {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs?.[0];
        if (!tab) {
          sendResponse({ status: "error", message: "No active tab found" });
          return;
        }
        chrome.windows.create({ tabId: tab.id }, (newWin) => {
          if (chrome.runtime.lastError) {
            sendResponse({ status: "error", message: chrome.runtime.lastError.message });
          } else {
            sendResponse({
              status: "ok",
              action: "pop_tab_to_window",
              tabId: tab.id,
              windowId: newWin.id
            });
          }
        });
      });
      return true; // async
    }

    case "ask_page": {
      chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        const tab = tabs?.[0];
        if (!tab?.id) {
          sendResponse({ status: "error", message: "No active tab found" });
          return;
        }

        const [{ result: extraction }] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const clamp = (s, max = 60000) => (s || "").slice(0, max);
            return clamp(document.body?.innerText || "");
          }
        });

        if (!extraction) {
          sendResponse({ status: "error", message: "No page text available" });
          return;
        }

        try {
          const session = await LanguageModel.create({
            output: { type: "text", languageCode: "en" }
          });

          const prompt = [
            {
              role: "system",
              content: "You are a page assistant. Answer the question using ONLY the text from the page provided. Be concise and factual."
            },
            { role: "user", content: "Page:\n" + extraction },
            { role: "user", content: "Question:\n" + data.args.question }
          ];

          const answer = await session.prompt(prompt);
          session.destroy?.();

          sendResponse({ status: "ok", action: "ask_page", answer: String(answer).trim() });
        } catch (err) {
          sendResponse({ status: "error", message: err.message });
        }
      });
      return true;
    }

    case "translate_page": {
      // Open a translated view using Google Translate web. Default language 'en' when not provided.
      const targetLangRaw = (args?.lang || "en").toString().trim();
      // Basic normalization: accept common names/codes
      const norm = (s) => s.toLowerCase().trim();
      const map = {
        english: "en", en: "en",
        spanish: "es", es: "es",
        french: "fr", fr: "fr",
        german: "de", de: "de",
        hindi: "hi", hi: "hi",
        telugu: "te", te: "te",
        tamil: "ta", ta: "ta",
        chinese: "zh-CN", "zh-cn": "zh-CN", zh: "zh-CN",
        japanese: "ja", ja: "ja",
        korean: "ko", ko: "ko",
        arabic: "ar", ar: "ar",
        portuguese: "pt", pt: "pt",
        russian: "ru", ru: "ru",
        italian: "it", it: "it"
      };
      const lang = map[norm(targetLangRaw)] || targetLangRaw;

      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs?.[0];
        if (!tab?.url) {
          sendResponse({ status: "error", message: "No active tab URL" });
          return;
        }
        const src = encodeURIComponent(tab.url);
        const url = `https://translate.google.com/translate?sl=auto&tl=${encodeURIComponent(lang)}&u=${src}`;
        chrome.tabs.create({ url }, (newTab) => {
          if (chrome.runtime.lastError) {
            sendResponse({ status: "error", message: chrome.runtime.lastError.message });
          } else {
            sendResponse({ status: "ok", action: "translate_page", lang, tabId: newTab?.id, url });
          }
        });
      });
      return true; // async
    }

    case "open_email": {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs?.[0];
        if (!tab?.id || !tab?.url) {
          sendResponse({ status: "error", message: "No active tab found" });
          return;
        }
        
        // Check if we're on Gmail
        let isGmail = false;
        try {
          const u = new URL(tab.url);
          isGmail = /(^|\.)mail\.google\.com$/i.test(u.host) || /gmail/i.test(u.host);
        } catch (_) {}
        
        if (!isGmail) {
          sendResponse({ status: "error", message: "open_email only works on Gmail" });
          return;
        }

        chrome.scripting.executeScript(
          {
            target: { tabId: tab.id },
            args: [args],
            func: (emailArgs) => {
              const { index, sender, subject, rawUtterance } = emailArgs || {};

              // Helpers
              const visible = (el) => !!(el && el.offsetParent !== null && !el.disabled);
              const normalize = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();
              const byTop = (a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top;
              const dedupe = (arr) => Array.from(new Set(arr));

              // Parse ordinal index from the utterance (1-based). Supports: 1st/2nd/3rd/10th, first/second/third, twenty first, bare numbers.
              const parseOrdinalFromUtterance = (text) => {
                if (!text) return null;
                const t = normalize(text);
                const m1 = t.match(/\b(\d+)(st|nd|rd|th)\b/);
                if (m1) { const n = parseInt(m1[1], 10); if (Number.isFinite(n) && n > 0) return n; }
                const m2 = t.match(/\b(?:open|go\s*to|select|click)\s+(?:the\s+)?(\d{1,3})\b/);
                if (m2) { const n = parseInt(m2[1], 10); if (Number.isFinite(n) && n > 0) return n; }
                const words = t.split(/[^a-z0-9]+/i).filter(Boolean);
                const card = { one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10, eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19, twenty:20,thirty:30,forty:40,fifty:50,sixty:60,seventy:70,eighty:80,ninety:90 };
                const ord = { first:1,second:2,third:3,fourth:4,fifth:5,sixth:6,seventh:7,eighth:8,ninth:9,tenth:10, eleventh:11,twelfth:12,thirteenth:13,fourteenth:14,fifteenth:15,sixteenth:16,seventeenth:17,eighteenth:18,nineteenth:19, twentieth:20,thirtieth:30,fortieth:40,fiftieth:50,sixtieth:60,seventieth:70,eightieth:80,ninetieth:90, last:-1 };
                for (const w of words) { if (ord[w] != null) return ord[w]; }
                for (let i = 0; i < words.length - 1; i++) {
                  const a = words[i], b = words[i+1];
                  if (card[a] && ord[b] && ord[b] < 10) return card[a] + ord[b];
                }
                return null;
              };

              // Find email rows strictly as visible message rows and sort by on-screen order
              const findEmailRows = () => {
                const preferred = [
                  'tr.zA',
                  'div[role="listitem"][data-thread-id]',
                  'div[role="listitem"][data-legacy-thread-id]',
                  'div[data-thread-id]',
                  'div[data-legacy-thread-id]'
                ];
                let rows = [];
                for (const sel of preferred) {
                  rows = rows.concat(Array.from(document.querySelectorAll(sel)).filter(visible));
                }
                if (!rows.length) {
                  rows = rows.concat(Array.from(document.querySelectorAll('tr[role="row"], div[role="listitem"]')).filter(visible));
                }
                rows = dedupe(rows).filter((row) => {
                  const t = normalize(row.innerText || "");
                  if (!t || t.length < 8) return false;
                  if (/^primary$|^social$|^promotions$|^updates$|^forums$/.test(t)) return false;
                  return true;
                }).sort(byTop);
                return rows;
              };

              const emailRows = findEmailRows();
              if (!emailRows.length) return { success: false, reason: 'no_emails_found' };

              let targetRow = null;

              // If sender/subject filters exist, use those first
              if (sender || subject) {
                const sNorm = normalize(sender);
                const subNorm = normalize(subject);
                for (const row of emailRows) {
                  const text = normalize(row.innerText || "");
                  let matches = true;
                  if (sender) {
                    if (!text.includes(sNorm)) {
                      const words = (sNorm || '').split(' ').filter(Boolean);
                      matches = words.some(w => w.length >= 2 && text.includes(w));
                    }
                  }
                  if (matches && subject) {
                    if (!text.includes(subNorm)) {
                      const words = (subNorm || '').split(' ').filter(Boolean);
                      matches = words.some(w => w.length >= 2 && text.includes(w));
                    }
                  }
                  if (matches) { targetRow = row; break; }
                }
              }

              // Resolve index: prefer ordinal parsed from utterance, then provided index
              let resolvedIndex = null;
              const utterIdx = parseOrdinalFromUtterance(rawUtterance);
              if (utterIdx != null) resolvedIndex = utterIdx;
              else if (Number.isFinite(index) && index > 0) resolvedIndex = Math.floor(index);
              if (resolvedIndex === -1) resolvedIndex = emailRows.length; // 'last'

              if (!targetRow && resolvedIndex && resolvedIndex > 0) {
                const zero = Math.min(Math.max(1, resolvedIndex) - 1, emailRows.length - 1);
                targetRow = emailRows[zero];
              }

              if (!targetRow) targetRow = emailRows[0];
              if (!targetRow) return { success: false, reason: 'no_matching_email' };

              // Subject extraction
              let extractedSubject = 'Email';
              try {
                const subjNode = targetRow.querySelector('.bog, .y6, [role="link"] span, a span');
                extractedSubject = (subjNode?.innerText || targetRow.innerText || '').split('\n')[0].trim() || 'Email';
              } catch (_) {}

              // Clickable target
              const clickable = targetRow.querySelector('a[href^="#"], a[role="link"], a, [role="link"]') || targetRow;

              // Highlight and click
              const prev = targetRow.style.outline;
              targetRow.style.outline = '2px solid #1a73e8';
              targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
              setTimeout(() => { try { targetRow.style.outline = prev || ''; } catch(_){} }, 800);

              try {
                clickable.click();
                return { success: true, subject: extractedSubject, method: 'click', element: clickable.tagName };
              } catch (_) {
                return { success: false, reason: 'no_clickable_element' };
              }
            }
          },
          (results) => {
            const res = results?.[0]?.result;
            if (res?.success) {
              sendResponse({ 
                status: "ok", 
                action: "opened_email", 
                subject: res.subject,
                method: res.method 
              });
            } else {
              sendResponse({ 
                status: "error", 
                message: `Failed to open email: ${res?.reason || "unknown"}` 
              });
            }
          }
        );
      });
      return true; // async
    }

    case "open_gmail_section": {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs?.[0];
        if (!tab?.id || !tab?.url) {
          sendResponse({ status: "error", message: "No active tab found" });
          return;
        }

        let isGmail = false;
        try {
          const u = new URL(tab.url);
          isGmail = /(^|\.)mail\.google\.com$/i.test(u.host) || /gmail/i.test(u.host);
        } catch (_) {}
        if (!isGmail) {
          sendResponse({ status: "error", message: "open_gmail_section only works on Gmail" });
          return;
        }

        const section = (args?.section || "").toString().toLowerCase().trim();
        if (!section) {
          sendResponse({ status: "error", message: "Missing section" });
          return;
        }

        chrome.scripting.executeScript(
          {
            target: { tabId: tab.id },
            args: [section],
            func: async (sec) => {
              const normalize = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();
              const visible = (el) => !!(el && el.offsetParent !== null && !el.disabled);

              const synonyms = {
                inbox: ["inbox", "primary"],
                spam: ["spam", "junk"],
                drafts: ["drafts", "draft"],
                sent: ["sent", "sent mail", "sent messages"],
                important: ["important"],
                starred: ["starred"],
                all: ["all mail", "all"],
                trash: ["trash", "bin"],
                snoozed: ["snoozed"],
                scheduled: ["scheduled"],
                promotions: ["promotions"],
                social: ["social"],
                updates: ["updates"],
                forums: ["forums"]
              };

              // Build a set of acceptable labels to match
              const wanted = new Set();
              for (const [key, vals] of Object.entries(synonyms)) {
                if (key === sec) vals.forEach(v => wanted.add(v));
              }
              if (!wanted.size) {
                // If unknown token, try to match it directly
                wanted.add(sec);
              }

              const isCategory = ["promotions","social","updates","forums","primary"].includes(sec);

              // If this is a top category, first try the top [role=tab] buttons
              if (isCategory) {
                const tabs = Array.from(document.querySelectorAll('[role="tab"]')).filter(visible);
                const readLabel = (el) => {
                  const attrs = [
                    el.getAttribute?.('aria-label'),
                    el.getAttribute?.('data-tooltip'),
                    el.getAttribute?.('title'),
                    el.textContent
                  ];
                  return normalize(attrs.filter(Boolean).join(' ').trim());
                };
                const scoreTab = (lab) => {
                  let s = 0; lab = normalize(lab);
                  wanted.forEach(w => {
                    if (lab === w) s += 120; // stronger for tabs
                    else if (lab.startsWith(w)) s += 80;
                    else if (lab.includes(w)) s += 60;
                  });
                  return s;
                };
                let best = null, bestScore = -1;
                for (const el of tabs) {
                  const lab = readLabel(el);
                  if (!lab) continue;
                  const sc = scoreTab(lab);
                  if (sc > bestScore) { best = { el, lab }; bestScore = sc; }
                }
                if (best && bestScore >= 60) {
                  try {
                    best.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    best.el.click();
                    return { success: true, section: sec, label: best.lab, via: 'tab' };
                  } catch (_) { /* fall through to left-nav scan */ }
                }
              }

              // Query left nav and general document
              const containers = [ document ];

              let candidates = [];

              const pushIf = (el, label) => {
                if (!el || !visible(el)) return;
                const l = normalize(
                  label ||
                  el.getAttribute?.('aria-label') ||
                  el.getAttribute?.('data-tooltip') ||
                  el.getAttribute?.('title') ||
                  el.textContent || ""
                );
                if (!l) return;
                candidates.push({ el, label: l });
              };

              // Left nav items often are links or divs with aria-label or title
              const selectors = [
                'a[aria-label]', 'a[title]', 'a[href]', 'div[aria-label]', 'div[role="tab"]', 'div[role="link"]', 'span[aria-label]'
              ];
              for (const sel of selectors) {
                containers.forEach(root => {
                  document.querySelectorAll(sel).forEach(el => pushIf(el));
                });
              }

              // Score and pick best match
              const score = (lab) => {
                lab = normalize(lab);
                let s = 0;
                wanted.forEach(w => {
                  if (lab === w) s += 100;
                  else if (lab.startsWith(w)) s += 60;
                  else if (lab.includes(w)) s += 40;
                });
                return s;
              };

              const findBest = () => {
                let best = null, bestScore = -1;
                for (const c of candidates) {
                  const sc = score(c.label);
                  if (sc > bestScore) { best = c; bestScore = sc; }
                }
                return best && bestScore >= 40 ? best : null;
              };

              let best = findBest();
              if (best) {
                try { best.el.scrollIntoView({ behavior: 'smooth', block: 'center' }); best.el.click(); return { success: true, section: sec, label: best.label, via: 'nav' }; }
                catch { /* continue to expand more */ }
              }

              // Try expanding 'More' to reveal hidden folders
              const findNavContainers = () => {
                const cands = [];
                const sels = [
                  'div[role="navigation"]',
                  'nav[role="navigation"]',
                  'div[aria-label*="nav" i]',
                  'div[aria-label*="menu" i]',
                  'div[gh="nv"]'
                ];
                for (const s of sels) {
                  document.querySelectorAll(s).forEach(el => { if (visible(el)) cands.push(el); });
                }
                return cands.length ? cands : [document.body || document];
              };

              const maybeClickMore = () => {
                const roots = findNavContainers();
                const all = [];
                const selAll = '[role="button"], button, a, div, span';
                for (const r of roots) {
                  r.querySelectorAll(selAll).forEach(el => { if (visible(el)) all.push(el); });
                }
                for (const el of all) {
                  const lab = normalize(
                    el.getAttribute?.('aria-label') ||
                    el.getAttribute?.('data-tooltip') ||
                    el.getAttribute?.('title') ||
                    el.textContent || ''
                  );
                  if (!lab) continue;
                  // Must include 'more' and NOT include 'less'
                  if (/\bmore\b/i.test(lab) && !/\bless\b/i.test(lab)) {
                    try { el.scrollIntoView({ behavior:'smooth', block:'center' }); el.click(); return true; } catch { /* noop */ }
                  }
                }
                return false;
              };

              const tryExpandAndReselect = async () => {
                const expanded = maybeClickMore();
                if (!expanded) return null;
                await new Promise(r => setTimeout(r, 400));
                candidates = [];
                for (const sel of selectors) {
                  containers.forEach(root => { document.querySelectorAll(sel).forEach(el => pushIf(el)); });
                }
                return findBest();
              };

              let bestAfterMore = await tryExpandAndReselect();
              if (bestAfterMore) {
                try { bestAfterMore.el.scrollIntoView({ behavior: 'smooth', block: 'center' }); bestAfterMore.el.click(); return { success: true, section: sec, label: bestAfterMore.label, via: 'nav+more' }; }
                catch { /* continue to fallback */ }
              }

              // One more attempt in case there are nested 'More' toggles
              bestAfterMore = await tryExpandAndReselect();
              if (bestAfterMore) {
                try { bestAfterMore.el.scrollIntoView({ behavior: 'smooth', block: 'center' }); bestAfterMore.el.click(); return { success: true, section: sec, label: bestAfterMore.label, via: 'nav+more2' }; }
                catch { /* continue to fallback */ }
              }

              // Try direct anchor links with hashes present in DOM
              const anchorMap = {
                promotions: '#category/promo',
                social: '#category/social',
                updates: '#category/updates',
                forums: '#category/forums',
                spam: '#spam',
                drafts: '#drafts',
                sent: '#sent',
                important: '#imp',
                starred: '#starred',
                all: '#all',
                trash: '#trash',
                bin: '#trash',
                inbox: '#inbox',
                primary: '#inbox'
              };
              const targetAnchorHash = anchorMap[sec];
              if (targetAnchorHash) {
                const a = document.querySelector(`a[href*="${CSS.escape(targetAnchorHash)}"]`);
                if (a && visible(a)) {
                  try { a.scrollIntoView({ behavior:'smooth', block:'center' }); a.click(); return { success:true, section: sec, via:'anchor', label: targetAnchorHash }; } catch { /* fall through */ }
                }
              }

              // Final fallback: navigate via Gmail hash routes
              const routeMap = {
                inbox: '#inbox',
                primary: '#inbox',
                spam: '#spam',
                drafts: '#drafts',
                sent: '#sent',
                important: '#imp',
                starred: '#starred',
                all: '#all',
                trash: '#trash',
                bin: '#trash',
                snoozed: '#snoozed',
                scheduled: '#scheduled',
                promotions: '#category/promo',
                social: '#category/social',
                updates: '#category/updates',
                forums: '#category/forums'
              };
              const targetHash = routeMap[sec];
              if (targetHash) {
                try {
                  const u = new URL(window.location.href);
                  if (u.hash !== targetHash) {
                    u.hash = targetHash;
                    window.location.assign(u.toString());
                  } else {
                    // force reload of the same hash
                    window.location.reload();
                  }
                  return { success: true, section: sec, via: 'hash', label: targetHash };
                } catch (_) {
                  // fallback to setting hash directly
                  try { window.location.hash = targetHash; return { success: true, section: sec, via: 'hash2', label: targetHash }; }
                  catch { return { success: false, reason: 'route_nav_failed' }; }
                }
              }

              return { success: false, reason: 'section_not_found' };
            }
          },
          (results) => {
            const res = results?.[0]?.result;
            if (res?.success) {
              sendResponse({ status: 'ok', action: 'opened_gmail_section', section: args?.section, label: res.label });
            } else {
              sendResponse({ status: 'error', message: res?.reason || 'section_open_failed' });
            }
          }
        );
      });
      return true;
    }

    case "gmail_reply": {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs?.[0];
        if (!tab?.id || !tab?.url) {
          sendResponse({ status: "error", message: "No active tab found" });
          return;
        }
        let isGmail = false;
        try { const u = new URL(tab.url); isGmail = /(^|\.)mail\.google\.com$/i.test(u.host) || /gmail/i.test(u.host); } catch(_){}
        if (!isGmail) { sendResponse({ status: "error", message: "gmail_reply only works on Gmail" }); return; }

        const mode = (args?.mode === 'reply_all') ? 'reply_all' : 'reply';

        chrome.scripting.executeScript(
          {
            target: { tabId: tab.id },
            args: [mode],
            func: (replyMode) => {
              const visible = (el) => !!(el && el.offsetParent !== null && !el.disabled);
              const normalize = (s) => (s||'').toLowerCase().replace(/\s+/g,' ').trim();

              // If a compose box is already open for this thread, focus it
              const compose = document.querySelector('div[role="textbox"], div[aria-label="Message Body"]');
              if (compose && visible(compose)) {
                try { compose.focus(); return { success:true, method:'focus_compose' }; } catch(_){}
              }

              // Look for reply buttons within a conversation view
              const candidates = [];
              const pushIf = (el) => { if (el && visible(el)) candidates.push(el); };
              const selectors = [
                'div[role="button"][data-tooltip*="Reply" i]',
                'div[role="button"][aria-label*="Reply" i]',
                'span[role="button"][aria-label*="Reply" i]',
                'div[role="button"][data-tooltip*="Reply all" i]',
                'div[role="button"][aria-label*="Reply all" i]'
              ];
              selectors.forEach(sel => document.querySelectorAll(sel).forEach(pushIf));

              const score = (el) => {
                const lab = normalize(el.getAttribute('aria-label') || el.getAttribute('data-tooltip') || el.title || el.textContent);
                let s = 0;
                if (replyMode === 'reply_all') {
                  if (/\breply all\b/i.test(lab)) s += 100;
                  if (/\breply\b/i.test(lab)) s += 40;
                } else {
                  if (/\breply all\b/i.test(lab)) s += 30; // lower than plain reply
                  if (/\breply\b/i.test(lab)) s += 100;
                }
                return s;
              };

              let best = null, bestScore = -1;
              for (const el of candidates) {
                const sc = score(el);
                if (sc > bestScore) { best = el; bestScore = sc; }
              }

              if (best && bestScore >= 60) {
                try { best.scrollIntoView({ behavior:'smooth', block:'center' }); best.click(); return { success:true, method:'click_button' }; }
                catch(_){}
              }

              // Keyboard fallback: 'r' for reply, 'a' for reply all
              try {
                const key = replyMode === 'reply_all' ? 'a' : 'r';
                const press = (type) => document.dispatchEvent(new KeyboardEvent(type, { bubbles:true, cancelable:true, key, code: key.toUpperCase(), keyCode: key.charCodeAt(0), which: key.charCodeAt(0) }));
                press('keydown'); press('keypress'); press('keyup');
                return { success:true, method:'keyboard' };
              } catch(_){}

              return { success:false, reason:'reply_controls_not_found' };
            }
          },
          (results) => {
            const res = results?.[0]?.result;
            if (res?.success) {
              sendResponse({ status:'ok', action:'gmail_reply', method: res.method, mode });
            } else {
              sendResponse({ status:'error', message: res?.reason || 'gmail_reply_failed' });
            }
          }
        );
      });
      return true;
    }

    case "gmail_forward": {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs?.[0];
        if (!tab?.id || !tab?.url) { sendResponse({ status:"error", message:"No active tab found" }); return; }
        let isGmail=false; try { const u=new URL(tab.url); isGmail=/(^|\.)mail\.google\.com$/i.test(u.host)||/gmail/i.test(u.host);} catch(_){ }
        if (!isGmail) { sendResponse({ status:"error", message:"gmail_forward only works on Gmail"}); return; }
        const recips = { to: args?.to||[], cc: args?.cc||[], bcc: args?.bcc||[] };
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          args: [recips],
          func: async (recips) => {
            const visible = (el)=>!!(el&&el.offsetParent!==null&&!el.disabled);
            const normalize=(s)=>(s||'').toLowerCase();
            // Find Forward button and click
            const btnSel = [
              'div[role="button"][data-tooltip*="Forward" i]',
              'div[role="button"][aria-label*="Forward" i]',
              'span[role="button"][aria-label*="Forward" i]'
            ].join(',');
            let btn = Array.from(document.querySelectorAll(btnSel)).find(visible);
            if (!btn) {
              // Sometimes under overflow menu (three-dots)
              const more = Array.from(document.querySelectorAll('div[role="button"][aria-label*="More" i], div[role="button"][data-tooltip*="More" i]')).find(visible);
              try { more?.click(); await new Promise(r=>setTimeout(r,200)); } catch(_){ }
              btn = Array.from(document.querySelectorAll(btnSel)).find(visible);
            }
            try { btn?.scrollIntoView({behavior:'smooth',block:'center'}); btn?.click(); } catch(_){ }
            // Wait for compose area
            await new Promise(r=>setTimeout(r,350));

            // Fill recipients if provided
            const fill = (fieldLabel, values) => {
              if (!values?.length) return 0;
              // Reveal Cc/Bcc fields if needed
              const reveal = Array.from(document.querySelectorAll('span[role="link"], div[role="button"]'))
                .find(el => /\bcc\b|\bbcc\b/i.test(el.textContent||''));
              try { if (reveal) reveal.click(); } catch(_){ }
              let count = 0;
              const tagSel = 'input[aria-label*="To" i], input[aria-label*="Cc" i], input[aria-label*="Bcc" i]';
              const inputs = Array.from(document.querySelectorAll(tagSel));
              const matchField = (label) => inputs.find(el => /input/i.test(el.tagName) && normalize(el.getAttribute('aria-label')||'').includes(label));
              const target = matchField(fieldLabel);
              if (target) {
                target.focus();
                for (const v of values) {
                  target.value = '';
                  target.dispatchEvent(new Event('input',{bubbles:true}));
                  target.value = v;
                  target.dispatchEvent(new Event('input',{bubbles:true}));
                  // press Enter or comma to commit chip
                  target.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'Enter',code:'Enter',keyCode:13,which:13}));
                  target.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true,cancelable:true,key:'Enter',code:'Enter',keyCode:13,which:13}));
                  count++;
                }
              }
              return count;
            };
            const added = {
              to: fill('to', recips.to),
              cc: fill('cc', recips.cc),
              bcc: fill('bcc', recips.bcc)
            };
            return { success:true, action:'forward', added };
          }
        }, (results)=>{
          const res = results?.[0]?.result;
          if (res?.success) sendResponse({ status:'ok', action:'gmail_forward', info: res });
          else sendResponse({ status:'error', message: res?.reason || 'gmail_forward_failed' });
        });
      });
      return true;
    }

    case "gmail_update_recipients": {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs?.[0]; if (!tab?.id||!tab?.url){ sendResponse({status:'error', message:'No active tab found'}); return; }
        let isGmail=false; try{ const u=new URL(tab.url); isGmail=/(^|\.)mail\.google\.com$/i.test(u.host)||/gmail/i.test(u.host);}catch(_){ }
        if (!isGmail) { sendResponse({ status:'error', message:'gmail_update_recipients only works on Gmail' }); return; }
        const payload = {
          toAdd: args?.toAdd||[], ccAdd: args?.ccAdd||[], bccAdd: args?.bccAdd||[],
          toRemove: args?.toRemove||[], ccRemove: args?.ccRemove||[], bccRemove: args?.bccRemove||[]
        };
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          args: [payload],
          func: (p) => {
            const normalize=(s)=>(s||'').toLowerCase();
            const visible = (el)=>!!(el&&el.offsetParent!==null&&!el.disabled);
            const inputs = Array.from(document.querySelectorAll('input[aria-label]'));
            const chipsSel = 'div[role="listitem"][data-hovercard-id], span[email], div[role="listitem"][aria-label*="Remove"]';
            const typeIn = (label, values)=>{
              if (!values?.length) return 0;
              const field = inputs.find(el=>normalize(el.getAttribute('aria-label')).includes(label));
              if (!field) return 0;
              field.focus();
              let c=0;
              for (const v of values) {
                field.value=''; field.dispatchEvent(new Event('input',{bubbles:true}));
                field.value=v; field.dispatchEvent(new Event('input',{bubbles:true}));
                field.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'Enter',code:'Enter',keyCode:13,which:13}));
                field.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true,cancelable:true,key:'Enter',code:'Enter',keyCode:13,which:13}));
                c++;
              }
              return c;
            };
            const removeFrom = (label, values)=>{
              if (!values?.length) return 0;
              const area = inputs.find(el=>normalize(el.getAttribute('aria-label')).includes(label))?.closest('div');
              if (!area) return 0;
              let removed=0;
              const chips = Array.from(area.querySelectorAll(chipsSel)).filter(visible);
              for (const v of values){
                const vn = normalize(v);
                const chip = chips.find(ch=>normalize(ch.getAttribute('aria-label')||ch.getAttribute('data-hovercard-id')||ch.getAttribute('email')||ch.textContent).includes(vn));
                if (chip){
                  const rm = chip.querySelector('[aria-label*="Remove" i], [data-tooltip*="Remove" i], [role="button"]');
                  try { (rm||chip).click(); removed++; } catch(_){ }
                }
              }
              return removed;
            };
            const added = {
              to: typeIn('to', p.toAdd), cc: typeIn('cc', p.ccAdd), bcc: typeIn('bcc', p.bccAdd)
            };
            const removed = {
              to: removeFrom('to', p.toRemove), cc: removeFrom('cc', p.ccRemove), bcc: removeFrom('bcc', p.bccRemove)
            };
            return { success:true, added, removed };
          }
        }, (results)=>{
          const res = results?.[0]?.result;
          if (res?.success) sendResponse({status:'ok', action:'gmail_update_recipients', info: res});
          else sendResponse({status:'error', message: res?.reason || 'gmail_update_recipients_failed'});
        });
      });
      return true;
    }

    case "gmail_send": {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs?.[0]; if (!tab?.id||!tab?.url){ sendResponse({status:'error', message:'No active tab found'}); return; }
        let isGmail=false; try{ const u=new URL(tab.url); isGmail=/(^|\.)mail\.google\.com$/i.test(u.host)||/gmail/i.test(u.host);}catch(_){ }
        if (!isGmail) { sendResponse({ status:'error', message:'gmail_send only works on Gmail' }); return; }
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          args: [],
          func: () => {
            // Try clicking the Send button
            const btnSel = [
              'div[role="button"][data-tooltip*="Send" i]',
              'div[role="button"][aria-label*="Send" i]'
            ].join(',');
            const btn = Array.from(document.querySelectorAll(btnSel)).find(el=>el && el.offsetParent !== null);
            if (btn) { try { btn.scrollIntoView({behavior:'smooth',block:'center'}); btn.click(); return {success:true, method:'click'}; } catch(_){} }
            // Fallback: keyboard shortcut Ctrl/Cmd + Enter
            try {
              const meta = navigator.platform.includes('Mac');
              const opts = { bubbles:true, cancelable:true, key:'Enter', code:'Enter', keyCode:13, which:13, [meta?'metaKey':'ctrlKey']: true };
              const active = document.activeElement || document.body;
              active.dispatchEvent(new KeyboardEvent('keydown', opts));
              active.dispatchEvent(new KeyboardEvent('keyup', opts));
              return { success:true, method:'keyboard' };
            } catch(_){ }
            return { success:false, reason:'send_button_not_found' };
          }
        }, (results)=>{
          const res = results?.[0]?.result;
          if (res?.success) sendResponse({ status:'ok', action:'gmail_send', method: res.method });
          else sendResponse({ status:'error', message: res?.reason || 'gmail_send_failed' });
        });
      });
      return true;
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
