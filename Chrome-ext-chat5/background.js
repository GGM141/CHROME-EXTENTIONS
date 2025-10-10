/*
 * Background service worker for the Tab Monitor Closer extension.
 *
 * Tracks tab open times, closes unread tabs after the configured threshold,
 * and notifies the user with an Undo option (including optional Gmail/Telegram alerts).
 */

const DEFAULT_THRESHOLD_HOURS = 24;
const DEFAULT_THRESHOLD_MINUTES = 0;
const DEFAULT_CHECK_INTERVAL_MINUTES = 60; // fallback check period
const MAX_HISTORY = 50;

// Guard against overlapping checks
let checkInProgress = false;
let checkGuardTimer = null;

// Serialize writes to storage to avoid lost updates under concurrency
let historyWriteChain = Promise.resolve();
let badgeWriteChain = Promise.resolve();
let undoWriteChain = Promise.resolve();

// Initialize storage on install.  Record the current time for all open tabs
// and create a periodic alarm.  We use an alarm instead of setInterval
// because alarms continue to fire even when the background is not kept
// alive, and they integrate well with the service worker lifecycle.
chrome.runtime.onInstalled.addListener(() => {
  chrome.tabs.query({}, (tabs) => {
    const openTimes = {};
    const now = Date.now();
    tabs.forEach((tab) => {
      // Use lastAccessed when available so tabs that were opened earlier
      // before the extension was installed can be evaluated immediately.
      openTimes[tab.id] = tab.lastAccessed || now;
    });
    chrome.storage.local.set({ openTimes });
  });
  // Schedule the periodic alarm based on saved settings (with defaults).
  ensureCheckAlarm();
  // Initialize defaults in sync storage if missing.
  chrome.storage.sync.get(["thresholdHours", "thresholdMinutes"], (cfg) => {
    const toSet = {};
    if (cfg.thresholdHours == null)
      toSet.thresholdHours = DEFAULT_THRESHOLD_HOURS;
    if (cfg.thresholdMinutes == null)
      toSet.thresholdMinutes = DEFAULT_THRESHOLD_MINUTES;
    if (Object.keys(toSet).length) chrome.storage.sync.set(toSet);
  });
  // Initialize badge appearance
  try {
    chrome.action.setBadgeBackgroundColor({ color: "#5C6BC0" });
    chrome.action.setBadgeText({ text: "" });
  } catch (e) {
    /* ignore */
  }
});

// Ensure alarm exists on browser startup as well.
chrome.runtime.onStartup.addListener(() => {
  ensureCheckAlarm();
  // Ensure we have sensible openTimes for existing tabs on browser startup.
  chrome.tabs.query({}, (tabs) => {
    chrome.storage.local.get('openTimes', (data) => {
      const openTimes = data.openTimes || {};
      const now = Date.now();
      tabs.forEach((tab) => {
        if (!openTimes[tab.id]) {
          openTimes[tab.id] = tab.lastAccessed || now;
        }
      });
      chrome.storage.local.set({ openTimes });
    });
  });
  try {
    chrome.action.setBadgeBackgroundColor({ color: "#5C6BC0" });
  } catch (e) {
    /* ignore */
  }
});

// Compute a dynamic check period based on the threshold, with sane bounds.
function computeCheckPeriodMinutes(hours, minutes) {
  const totalMinutes = Math.max(0, (Number(hours) || 0) * 60 + (Number(minutes) || 0));
  // Check roughly every quarter of the threshold, but at least every 1 minute and at most every 60 minutes.
  const dynamic = Math.ceil(totalMinutes / 4);
  return Math.max(1, Math.min(60, dynamic || DEFAULT_CHECK_INTERVAL_MINUTES));
}

function ensureCheckAlarm() {
  chrome.storage.sync.get(["thresholdHours", "thresholdMinutes"], (cfg) => {
    const hours = cfg.thresholdHours ?? DEFAULT_THRESHOLD_HOURS;
    const minutes = cfg.thresholdMinutes ?? DEFAULT_THRESHOLD_MINUTES;
    const totalMinutes = (Number(hours) || 0) * 60 + (Number(minutes) || 0);
    if (totalMinutes === 0) {
      // Disable periodic checks when timeout is 00:00
      chrome.alarms.clear("checkTabs", () => {});
      return;
    }
    const period = computeCheckPeriodMinutes(hours, minutes);
    chrome.alarms.create("checkTabs", { periodInMinutes: period });
  });
}

// Re-arm alarm automatically when threshold changes in sync storage
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  if ("thresholdHours" in changes || "thresholdMinutes" in changes) {
    ensureCheckAlarm();
  }
});

// When a tab is created, record the current time.  We consider this the
// moment the user opened the tab.  If the user navigates later, we'll
// update the open time in onUpdated.
chrome.tabs.onCreated.addListener((tab) => {
  chrome.storage.local.get("openTimes", (data) => {
    const openTimes = data.openTimes || {};
    openTimes[tab.id] = Date.now();
    chrome.storage.local.set({ openTimes });
  });
});

// When a tab finishes navigating to a new URL, reset its open time.  This
// ensures that switching pages within a tab resets the timer.  We check
// changeInfo.url so we only reset when the URL actually changes.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Reset on URL change or when a navigation completes.
  if (changeInfo.url || changeInfo.status === "complete") {
    chrome.storage.local.get("openTimes", (data) => {
      const openTimes = data.openTimes || {};
      openTimes[tabId] = Date.now();
      chrome.storage.local.set({ openTimes });
    });
    // No content script injection needed.
  }
});

// When a tab becomes active, reset its open time (user likely looked at it).
chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.storage.local.get("openTimes", (data) => {
    const openTimes = data.openTimes || {};
    openTimes[tabId] = Date.now();
    chrome.storage.local.set({ openTimes });
  });
  // No content script injection needed.
});

// When a tab is removed (closed by the user), forget its record.
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.get("openTimes", (data) => {
    const openTimes = data.openTimes || {};
    delete openTimes[tabId];
    chrome.storage.local.set({ openTimes });
  });
});

// Activity tracking functions
function checkTabActivity() {
  return {
    func: () => {
      const metrics = {
        scrollY: window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0,
        pageHeight: Math.max(
          document.documentElement.scrollHeight,
          document.body.scrollHeight,
          document.documentElement.offsetHeight
        ),
        viewHeight: window.innerHeight,
        hasInteracted: false,
        timestamp: Date.now()
      };
      
      // Проверяем, было ли взаимодействие со страницей
      if (window.__tabMonitorInteracted) {
        metrics.hasInteracted = true;
      }
      
      return metrics;
    }
  };
}

function injectActivityTracker() {
  return {
    func: () => {
      if (window.__tabMonitorInitialized) return;
      window.__tabMonitorInitialized = true;
      window.__tabMonitorInteracted = false;

      const markInteracted = () => {
        window.__tabMonitorInteracted = true;
      };

      // Отслеживаем различные типы взаимодействий
      window.addEventListener('click', markInteracted);
      window.addEventListener('keydown', markInteracted);
      window.addEventListener('mousemove', () => {
        if (!window.__tabMonitorInteracted) {
          const now = Date.now();
          if (!window.__lastMouseMove || now - window.__lastMouseMove > 1000) {
            window.__lastMouseMove = now;
            window.__mouseMovements = (window.__mouseMovements || 0) + 1;
            if (window.__mouseMovements > 5) {
              markInteracted();
            }
          }
        }
      });
    }
  };
}

// Periodically check all tracked tabs.  For each tab that has been open
// longer than the threshold, retrieve its scroll position. If the page has
// never been scrolled (scroll position is at the top), close the tab.
// We rely on the scroll position because the user asked
// to consider tabs unread if they remain at the top of the page.  We use
// chrome.scripting.executeScript to inject a small function into the tab
// that returns the current scroll offset.  If the scroll offset is zero
// (or less than zero, which can happen in some edge cases), we treat the
// tab as unread.
function checkTabsNow() {
  if (checkInProgress) return;
  checkInProgress = true;
  // Safety timer in case callbacks never fire
  if (checkGuardTimer) clearTimeout(checkGuardTimer);
  checkGuardTimer = setTimeout(() => {
    checkInProgress = false;
    checkGuardTimer = null;
  }, 60000);

  // Run the same logic as the periodic alarm immediately.
  chrome.storage.local.get(["openTimes"], (data) => {
    const openTimes = data.openTimes || {};
    const now = Date.now();
    chrome.storage.sync.get(
      ["thresholdHours", "thresholdMinutes"],
      (cfg) => {
        const thresholdHours = Number(cfg.thresholdHours);
        const thresholdMinutes = Number(cfg.thresholdMinutes);
        const hoursMs = (Number.isFinite(thresholdHours) ? thresholdHours : DEFAULT_THRESHOLD_HOURS) * 60 * 60 * 1000;
        const minutesMs = (Number.isFinite(thresholdMinutes) ? Math.max(0, thresholdMinutes) : DEFAULT_THRESHOLD_MINUTES) * 60 * 1000;
        const THRESHOLD_MS = hoursMs + minutesMs;
        // Iterate over a copy of the keys because we'll modify openTimes when
        // closing tabs.
        let pending = 0;
        const maybeFinish = () => {
          if (pending === 0) {
            if (checkGuardTimer) {
              clearTimeout(checkGuardTimer);
              checkGuardTimer = null;
            }
            checkInProgress = false;
          }
        };

        Object.keys(openTimes).forEach((idStr) => {
          const tabId = parseInt(idStr, 10);
          const opened = openTimes[idStr];
          if (!opened || now - opened <= THRESHOLD_MS) {
            return;
          }
          // Check the tab still exists before attempting to execute a script.
          pending++;
          chrome.tabs.get(tabId, (tab) => {
            if (chrome.runtime.lastError || !tab) {
              // Tab no longer exists; clean up.
              delete openTimes[idStr];
              chrome.storage.local.set({ openTimes });
              pending--; maybeFinish();
              return;
            }
            // Skip pinned tabs by default.
            if (tab.pinned) { pending--; maybeFinish(); return; }
            if (tab.audible) { pending--; maybeFinish(); return; }
            if (!tab.url || !isHttpLike(tab.url)) { pending--; maybeFinish(); return; }
            // Inject a script to get the current vertical scroll offset.
            chrome.scripting.executeScript(
              {
                target: { tabId: tabId },
                world: "MAIN",
                func: checkTabActivity().func,
              },
              (results) => {
                if (chrome.runtime.lastError) {
                  openTimes[idStr] = Date.now();
                  chrome.storage.local.set({ openTimes });
                  pending--; maybeFinish();
                  return;
                }

                const metrics = results && results[0] && results[0].result;
                if (!metrics) {
                  pending--; maybeFinish();
                  return;
                }

                // Инжектируем трекер активности, если еще не сделали
                chrome.scripting.executeScript({
                  target: { tabId: tabId },
                  world: "MAIN",
                  func: injectActivityTracker().func,
                });

                const isShortPage = metrics.pageHeight <= metrics.viewHeight * 1.2; // 20% запас
                const isRead = 
                  metrics.hasInteracted || // были взаимодействия
                  (!isShortPage && metrics.scrollY > 0); // или была прокрутка на длинной странице

                if (!isRead) {
                  const url = tab.url;
                  const title = tab.title || url;
                  // Close the tab.  This will trigger onRemoved, which cleans
                  // up the openTimes entry.
                  const prev = { windowId: tab.windowId, index: tab.index };
                  chrome.tabs.remove(tabId, () => {
                    const hadError = Boolean(chrome.runtime.lastError);
                    if (hadError) {
                      // Do not record history/badge on failure; keep openTimes to retry later.
                      pending--; maybeFinish();
                      return;
                    }
                    // Closing succeeded: clean up and record.
                    delete openTimes[idStr];
                    chrome.storage.local.set({ openTimes });
                    findSessionIdForUrl(url).then((sessionId) => {
                      addToHistory(url, title, { sessionId, prev });
                      notifyClosedTabByEmail(title, url);
                      notifyClosedTabByTelegram(title, url);
                      incrementBadgeCount();
                      notifyClosed(url, title, { sessionId, prev });
                    }).finally(() => {
                      pending--; maybeFinish();
                    });
                  });
                } else {
                  // Consider read; refresh timer to avoid repeated checks soon.
                  openTimes[idStr] = Date.now();
                  chrome.storage.local.set({ openTimes });
                  pending--; maybeFinish();
                }
              },
            );
          });
        });
        // If nothing qualified, finish immediately
        if (pending === 0) {
          maybeFinish();
        }
      },
    );
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "checkTabs") return;
  checkTabsNow();
});

// Helper: HTTP/HTTPS URL filter
function isHttpLike(url) {
  return /^https?:\/\//i.test(url);
}

// Notify user that a tab was closed; includes Undo button
function notifyClosed(url, title, restore) {
  const id = `closed-${Date.now()}-${Math.random()}`;
  const message = `Closed unread tab.\n${url}`;
  const options = {
    type: "basic",
    iconUrl: "icons/icon48.png",
    title: "Tab Monitor Closer",
    message,
    priority: 0,
    buttons: [{ title: "Undo" }],
  };
  chrome.notifications.create(id, options, () => {
    const entry = { url, restore: restore || null, ts: Date.now() };
    enqueueUndoMapPut(id, entry);
  });
}
// Email sending removed.

chrome.notifications.onButtonClicked.addListener(
  (notificationId, buttonIndex) => {
    if (buttonIndex !== 0) return;
    chrome.storage.local.get("undoMap", (data) => {
      const undoMap = data.undoMap || {};
      const entry = undoMap[notificationId];
      if (!entry) return;
      const { url, restore } = entry;
      const sessionId = restore && restore.sessionId;
      if (sessionId && chrome.sessions && chrome.sessions.restore) {
        chrome.sessions.restore(sessionId, (restored) => {
          if (chrome.runtime.lastError || !restored) {
            // Fallback to simple reopen
            const createOpts = { url };
            if (restore && typeof restore.windowId === "number")
              createOpts.windowId = restore.windowId;
            if (restore && typeof restore.index === "number")
              createOpts.index = restore.index;
            chrome.tabs.create(createOpts, () => {
              chrome.notifications.clear(notificationId, () => {});
              notifyRestored(url);
            });
          } else {
            chrome.notifications.clear(notificationId, () => {});
            notifyRestored(url);
          }
        });
      } else {
        const createOpts = { url };
        if (restore && typeof restore.windowId === "number")
          createOpts.windowId = restore.windowId;
        if (restore && typeof restore.index === "number")
          createOpts.index = restore.index;
        chrome.tabs.create(createOpts, () => {
          chrome.notifications.clear(notificationId, () => {});
          notifyRestored(url);
        });
      }
      delete undoMap[notificationId];
      chrome.storage.local.set({ undoMap });
    });
  },
);

// Clean up undo entries when the notification is closed/dismissed
chrome.notifications.onClosed.addListener((notificationId) => {
  chrome.storage.local.get("undoMap", (data) => {
    const undoMap = data.undoMap || {};
    if (undoMap[notificationId]) {
      delete undoMap[notificationId];
      chrome.storage.local.set({ undoMap });
    }
  });
});

function notifyRestored(url) {
  const id = `restored-${Date.now()}-${Math.random()}`;
  chrome.notifications.create(id, {
    type: "basic",
    iconUrl: "icons/icon48.png",
    title: "Tab Monitor Closer",
    message: `Restored tab.\n${url}`,
    priority: 0,
  });
}

// Maintain recent closed tabs history
function addToHistory(url, title, restore) {
  const entry = { url, title, ts: Date.now(), restore: restore || null };
  historyWriteChain = historyWriteChain
    .catch(() => {})
    .then(() => new Promise((resolve) => {
      chrome.storage.local.get("closedHistory", (data) => {
        const list = Array.isArray(data.closedHistory) ? data.closedHistory : [];
        list.unshift(entry);
        if (list.length > MAX_HISTORY) list.length = MAX_HISTORY;
        chrome.storage.local.set({ closedHistory: list }, () => {
          try {
            console.warn("[TMC] history append:", url, "len=", list.length);
          } catch (e) { /* ignore */ }
          // Also append to HTML log if configured
          // Persist the entry in a separate htmlLogEntries array for future aggregated export
          chrome.storage.local.get('htmlLogEntries', (d) => {
            const arr = Array.isArray(d.htmlLogEntries) ? d.htmlLogEntries : [];
            arr.unshift({ url, title, ts: Date.now() });
            if (arr.length > MAX_HISTORY) arr.length = MAX_HISTORY;
            chrome.storage.local.set({ htmlLogEntries: arr }, () => {
              // Only perform automatic export (download) if user enabled it in settings
              chrome.storage.sync.get('logExportOnClose', (cfg) => {
                const enabled = cfg.logExportOnClose == null ? true : Boolean(cfg.logExportOnClose);
                if (enabled) {
                  // Non-interactive export (overwrite)
                  writeHtmlLog(url, title).catch(() => {});
                }
              });
            });
          });
          resolve();
        });
      });
    }));
}

// Write an entry to the user's configured HTML log file in Downloads.
// The file will be created if missing, and new entries appended by
// downloading a small blob. We place entries inside a simple <ul> list.
async function writeHtmlLog(url, title) {
  try {
    const cfg = await new Promise((res) => chrome.storage.sync.get('logFileName', res));
    const filename = (cfg && cfg.logFileName) || 'closed-tabs.html';

    // Read persisted entries to produce a full aggregated HTML file
    const data = await new Promise((res) => chrome.storage.local.get('htmlLogEntries', res));
    const entries = Array.isArray(data.htmlLogEntries) ? data.htmlLogEntries : [];

    const listItems = entries
      .map((e) => {
        const safeTitle = escapeHtml(e.title || e.url || '');
        const safeUrl = escapeHtml(e.url || '');
        const when = new Date(e.ts || Date.now()).toLocaleString();
        return `<li><a href="${safeUrl}">${safeTitle}</a> <span style="color:#666; font-size:11px;">(${when})</span></li>`;
      })
      .join('\n');

    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Closed tabs</title></head><body><h1>Closed tabs</h1><ul>${listItems}</ul></body></html>`;
    // Create a base64 data URL because service worker context may not support
    // URL.createObjectURL for Blobs. downloads.download accepts data: URLs.
    const base64 = base64EncodeUtf8(html);
    const dataUrl = `data:text/html;charset=utf-8;base64,${base64}`;

    // Save the aggregated file, overwriting previous file of the same name when possible.
    await new Promise((resolve, reject) => {
      try {
        chrome.downloads.download({ url: dataUrl, filename, conflictAction: 'overwrite', saveAs: false }, (downloadId) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          resolve(downloadId);
        });
      } catch (e) {
        reject(e);
      }
    });
  } catch (e) {
    // ignore
  }
}

async function restoreFromHistory(entry) {
  const { url, restore } = entry || {};
  if (!url) return false;
  const sessionId = restore && restore.sessionId;
  return new Promise((resolve) => {
    if (sessionId && chrome.sessions && chrome.sessions.restore) {
      chrome.sessions.restore(sessionId, (restored) => {
        if (chrome.runtime.lastError || !restored) {
          const createOpts = { url };
          if (restore && typeof restore.windowId === "number")
            createOpts.windowId = restore.windowId;
          if (restore && typeof restore.index === "number")
            createOpts.index = restore.index;
          chrome.tabs.create(createOpts, () => {
            notifyRestored(url);
            resolve(true);
          });
        } else {
          notifyRestored(url);
          resolve(true);
        }
      });
    } else {
      const createOpts = { url };
      if (restore && typeof restore.windowId === "number")
        createOpts.windowId = restore.windowId;
      if (restore && typeof restore.index === "number")
        createOpts.index = restore.index;
      chrome.tabs.create(createOpts, () => {
        notifyRestored(url);
        resolve(true);
      });
    }
  });
}

// Badge counter helpers
function updateBadge(count) {
  try {
    const text = count > 0 ? String(count) : "";
    chrome.action.setBadgeText({ text });
  } catch (e) {
    /* ignore */
  }
}

function incrementBadgeCount() {
  badgeWriteChain = badgeWriteChain
    .catch(() => {})
    .then(() => new Promise((resolve) => {
      chrome.storage.local.get("badgeCount", (data) => {
        const count = Number(data.badgeCount) || 0;
        const next = count + 1;
        chrome.storage.local.set({ badgeCount: next }, () => {
          updateBadge(next);
          resolve();
        });
      });
    }));
}

function resetBadgeCount() {
  chrome.storage.local.set({ badgeCount: 0 }, () => updateBadge(0));
}

// Popup communication for history and badge
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'gmail-status') {
    (async () => {
      try {
        const status = await getGmailStatus();
        sendResponse({ ok: true, ...status });
      } catch (err) {
        sendResponse({ ok: false, error: String(err && (err.message || err)) });
      }
    })();
    return true;
  }
  if (msg.type === 'gmail-connect') {
    (async () => {
      try {
        await getGmailToken({ allowInteractive: true });
        const status = await getGmailStatus();
        sendResponse({ ok: true, ...status });
      } catch (err) {
        sendResponse({ ok: false, error: String(err && (err.message || err)) });
      }
    })();
    return true;
  }
  if (msg.type === 'gmail-signOut') {
    clearGmailTokens()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err && (err.message || err)) }));
    return true;
  }
  if (msg.type === 'gmail-send') {
    (async () => {
      try {
        const payload = msg.payload || {};
        const { to, subject, body } = payload;
        const allowInteractive = payload.allowInteractive !== false;
        await sendGmailMessage({ to, subject, body }, { allowInteractive });
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err && (err.message || err)) });
      }
    })();
    return true;
  }
  if (msg.type === 'telegram-send') {
    (async () => {
      await sendTelegramMessage(msg.payload || {});
      sendResponse({ ok: true });
    })().catch(err => sendResponse({ ok: false, error: String(err && (err.message || err)) }));
    return true;
  }
  if (msg.type === "getClosedHistory") {
  chrome.storage.local.get(["closedHistory", "badgeCount"], (data) => {
      sendResponse({
        ok: true,
        history: Array.isArray(data.closedHistory) ? data.closedHistory : [],
        badgeCount: Number(data.badgeCount) || 0,
      });
    });
    return true;
  }
  if (msg.type === "runCheckNow") {
    // Fire the check immediately. Respond right away.
    try { checkTabsNow(); } catch (e) {}
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === "resetBadge") {
    resetBadgeCount();
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === "exportHtmlNow") {
    (async () => {
      try {
        await writeHtmlLog();
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && (e.message || e)) });
      }
    })();
    return true;
  }
  if (msg.type === 'saveAsLogFile') {
    (async () => {
      try {
        // Build aggregated HTML (reuse writeHtmlLog internals but return blob URL)
        const data = await new Promise((res) => chrome.storage.local.get('htmlLogEntries', res));
        const entries = Array.isArray(data.htmlLogEntries) ? data.htmlLogEntries : [];
        const listItems = entries
          .map((e) => {
            const safeTitle = escapeHtml(e.title || e.url || '');
            const safeUrl = escapeHtml(e.url || '');
            const when = new Date(e.ts || Date.now()).toLocaleString();
            return `<li><a href="${safeUrl}">${safeTitle}</a> <span style="color:#666; font-size:11px;">(${when})</span></li>`;
          })
          .join('\n');
        const html = `<!doctype html><html><head><meta charset="utf-8"><title>Closed tabs</title></head><body><h1>Closed tabs</h1><ul>${listItems}</ul></body></html>`;
        // data URL fallback for service worker context
        const suggested = String(msg.suggestedName || 'closed-tabs.html');
        const base64 = base64EncodeUtf8(html);
        const dataUrl = `data:text/html;charset=utf-8;base64,${base64}`;
        const downloadId = await new Promise((resolve, reject) => {
          try {
            chrome.downloads.download({ url: dataUrl, filename: suggested, saveAs: true }, (id) => {
              if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
              resolve(id);
            });
          } catch (e) {
            reject(e);
          }
        });

        // Wait for the download to complete (or be interrupted) to capture final filename
        const final = await new Promise((resolve) => {
          const handler = (delta) => {
            if (delta.id !== downloadId) return;
            if (delta.state && delta.state.current === 'complete') {
              chrome.downloads.search({ id: downloadId }, (items) => {
                chrome.downloads.onChanged.removeListener(handler);
                resolve({ ok: true, items });
              });
            } else if (delta.state && (delta.state.current === 'interrupted')) {
              chrome.downloads.onChanged.removeListener(handler);
              resolve({ ok: false, error: 'interrupted' });
            }
          };
          chrome.downloads.onChanged.addListener(handler);
          // Timeout fallback: stop waiting after 20s
          setTimeout(() => {
            chrome.downloads.onChanged.removeListener(handler);
            resolve({ ok: false, error: 'timeout' });
          }, 20000);
        });

        if (final && final.ok && final.items && final.items[0]) {
          const filename = final.items[0].filename || final.items[0].finalUrl || suggested;
          // Persist the filename base (only the file part) into sync
          const parts = filename.split('\\');
          const basename = parts[parts.length - 1];
          chrome.storage.sync.set({ logFileName: basename }, () => {
            sendResponse({ ok: true, filename: basename });
          });
          return;
        }
        sendResponse({ ok: false, error: final && final.error });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && (e.message || e)) });
      }
    })();
    return true;
  }
  if (msg.type === "clearHistory") {
    chrome.storage.local.set({ closedHistory: [] }, () =>
      sendResponse({ ok: true }),
    );
    return true;
  }
  if (msg.type === "restoreClosed" && msg.index != null) {
    chrome.storage.local.get("closedHistory", async (data) => {
      const list = Array.isArray(data.closedHistory) ? data.closedHistory : [];
      const idx = Number(msg.index);
      const entry = list[idx];
      if (!entry) {
        sendResponse({ ok: false, error: "Not found" });
        return;
      }
      await restoreFromHistory(entry);
      // Remove restored entry and persist
      list.splice(idx, 1);
      chrome.storage.local.set({ closedHistory: list }, () =>
        sendResponse({ ok: true }),
      );
    });
    return true;
  }
  // No domain settings in simplified version.
});

// Try to find the sessionId of a just-closed tab by URL.
async function findSessionIdForUrl(url) {
  if (!chrome.sessions || !chrome.sessions.getRecentlyClosed) return null;
  for (let i = 0; i < 5; i++) {
    const entries = await new Promise((resolve) =>
      chrome.sessions.getRecentlyClosed({ maxResults: 20 }, resolve),
    );
    const hit = (entries || []).find(
      (e) => e.tab && e.tab.url === url && e.sessionId,
    );
    if (hit && hit.sessionId) return hit.sessionId;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

// Domain settings and content injection removed in simplified version.

// Helpers to serialize undoMap updates to avoid lost entries
function enqueueUndoMapPut(id, value) {
  undoWriteChain = undoWriteChain
    .catch(() => {})
    .then(() => new Promise((resolve) => {
      chrome.storage.local.get("undoMap", (data) => {
        const undoMap = data.undoMap || {};
        undoMap[id] = value;
        chrome.storage.local.set({ undoMap }, () => resolve());
      });
    }));
}

// =================== Gmail via chrome.identity.getAuthToken ===================

const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

function base64UrlEncodeUtf8(str) {
  const bytes = new TextEncoder().encode(str || '');
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64EncodeUtf8(str) {
  const bytes = new TextEncoder().encode(str || '');
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildPlainMime({ to, subject, body }) {
  const lines = [
    `To: ${to}`,
    `Subject: ${subject || ''}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    body || ''
  ];
  return lines.join('\r\n');
}

function getAuthTokenSilently() {
  return new Promise((resolve) => {
    chrome.identity.getAuthToken({ interactive: false }, (token) => {
      if (chrome.runtime.lastError || !token) resolve(null);
      else resolve(token);
    });
  });
}

function getAuthTokenInteractive() {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(chrome.runtime.lastError || new Error('No token'));
      } else {
        resolve(token);
      }
    });
  });
}

function clearGmailTokens() {
  return new Promise((resolve) => {
    chrome.identity.clearAllCachedAuthTokens(() => resolve());
  });
}

async function getGmailToken({ allowInteractive = false } = {}) {
  const silent = await getAuthTokenSilently();
  if (silent) return silent;
  if (!allowInteractive) return null;
  return getAuthTokenInteractive();
}

async function sendGmailMessage({ to, subject, body }, { allowInteractive = false } = {}) {
  if (!to) throw new Error('Missing recipient');
  const mime = buildPlainMime({ to, subject, body });
  const raw = base64UrlEncodeUtf8(mime);

  let token = await getGmailToken({ allowInteractive });
  if (!token) throw new Error('Not authorized');

  const doSend = async () => {
    const res = await fetch(GMAIL_SEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ raw })
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`Gmail send failed: ${res.status} ${text}`);
      err.status = res.status;
      throw err;
    }
    return res.json().catch(() => ({}));
  };

  try {
    return await doSend();
  } catch (err) {
    if (err && err.status === 401) {
      await clearGmailTokens();
      if (!allowInteractive) throw err;
      token = await getGmailToken({ allowInteractive: true });
      if (!token) throw err;
      return doSend();
    }
    throw err;
  }
}

async function notifyClosedTabByEmail(title, url) {
  try {
    const { notifyEmail } = await chrome.storage.sync.get('notifyEmail');
    if (!notifyEmail) return;
    const subject = `Closed as unread: ${title || url}`;
    const body = `The following tab was closed as unread:\n\n${title || url}\n${url}`;
    await sendGmailMessage({ to: notifyEmail, subject, body }, { allowInteractive: false });
  } catch (err) {
    console.warn('Gmail notification failed', err);
  }
}

async function getGmailStatus() {
  const token = await getAuthTokenSilently();
  if (!token) return { signedIn: false, email: null };
  const profile = await new Promise((resolve) => {
    if (!chrome.identity || !chrome.identity.getProfileUserInfo) {
      resolve({});
      return;
    }
    chrome.identity.getProfileUserInfo((info) => {
      if (chrome.runtime.lastError) resolve({});
      else resolve(info || {});
    });
  });
  return {
    signedIn: true,
    email: profile && profile.email ? profile.email : null
  };
}


// =================== Telegram Bot API ===================
// =================== Telegram Bot API ===================
const TELEGRAM_API_ORIGIN = 'https://api.telegram.org';

function escapeHtmlLite(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function sendTelegramMessage({ text, disablePreview = false } = {}) {
  const { tgToken, tgChatId } = await chrome.storage.sync.get([ 'tgToken', 'tgChatId' ]);
  if (!tgToken || !tgChatId) return; // not configured, do nothing
  if (!text) return;

  const url = `${TELEGRAM_API_ORIGIN}/bot${tgToken}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: tgChatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: Boolean(disablePreview)
    })
  });
  const data = await safeJson(res);
  if (!res.ok || (data && data.ok === false)) {
    const msg = (data && (data.description || data.error || data.message)) || `HTTP ${res.status}`;
    throw new Error(`Telegram send failed: ${msg}`);
  }
}

async function notifyClosedTabByTelegram(title, url) {
  try {
    const t = `<b>Closed as unread</b>\n<a href="${escapeHtmlLite(url)}">${escapeHtmlLite(title || url)}</a>`;
    await sendTelegramMessage({ text: t, disablePreview: false });
  } catch (e) {
    // silent
  }
}
