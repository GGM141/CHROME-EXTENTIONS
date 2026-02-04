/*
 * Background service worker for the Tab Monitor Closer extension.
 *
 * Tracks tab open times, closes unread tabs after the configured threshold,
 * and notifies the user with an Undo option. Email sending was removed.
 */

const DEFAULT_THRESHOLD_HOURS = 24;
const DEFAULT_THRESHOLD_MINUTES = 0;
const DEFAULT_CHECK_INTERVAL_MINUTES = 60; // fallback check period
const MAX_HISTORY = 50;
const DEBUG = false;

// Guard against overlapping checks
let checkInProgress = false;
let checkGuardTimer = null;

// Serialize writes to storage to avoid lost updates under concurrency
let historyWriteChain = Promise.resolve();
let badgeWriteChain = Promise.resolve();
let undoWriteChain = Promise.resolve();
let openTimesWriteChain = Promise.resolve();

function logDebug(...args) {
  if (!DEBUG) return;
  try {
    console.warn("[TMC]", ...args);
  } catch (e) {
    /* ignore */
  }
}

// Initialize storage on install.  Record the current time for all open tabs
// and create a periodic alarm.  We use an alarm instead of setInterval
// because alarms continue to fire even when the background is not kept
// alive, and they integrate well with the service worker lifecycle.
chrome.runtime.onInstalled.addListener(() => {
  chrome.tabs.query({}, (tabs) => {
    const openTimes = {};
    const now = Date.now();
    tabs.forEach((tab) => {
      openTimes[tab.id] = now;
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
    const period = computeCheckPeriodMinutes(
      cfg.thresholdHours ?? DEFAULT_THRESHOLD_HOURS,
      cfg.thresholdMinutes ?? DEFAULT_THRESHOLD_MINUTES,
    );
    chrome.alarms.create("checkTabs", { periodInMinutes: period });
    logDebug("Alarm set", { periodInMinutes: period });
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
  updateOpenTimes((openTimes) => {
    openTimes[tab.id] = Date.now();
  });
});

// When a tab finishes navigating to a new URL, reset its open time.  This
// ensures that switching pages within a tab resets the timer.  We check
// changeInfo.url so we only reset when the URL actually changes.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Reset on URL change or when a navigation completes.
  if (changeInfo.url || changeInfo.status === "complete") {
    updateOpenTimes((openTimes) => {
      openTimes[tabId] = Date.now();
    });
    // No content script injection needed.
  }
});

// When a tab becomes active, reset its open time (user likely looked at it).
chrome.tabs.onActivated.addListener(({ tabId }) => {
  updateOpenTimes((openTimes) => {
    openTimes[tabId] = Date.now();
  });
  // No content script injection needed.
});

// When a tab is removed (closed by the user), forget its record.
chrome.tabs.onRemoved.addListener((tabId) => {
  updateOpenTimes((openTimes) => {
    delete openTimes[tabId];
  });
});

// No scroll messages needed in simplified logic.

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
  const startedAt = Date.now();
  let scannedTabs = 0;
  let eligibleTabs = 0;
  logDebug("Check started");
  // Safety timer in case callbacks never fire
  if (checkGuardTimer) clearTimeout(checkGuardTimer);
  checkGuardTimer = setTimeout(() => {
    checkInProgress = false;
    checkGuardTimer = null;
    logDebug("Check guard timeout");
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
            logDebug("Check finished", {
              durationMs: Date.now() - startedAt,
              scannedTabs,
              eligibleTabs,
            });
          }
        };

        Object.keys(openTimes).forEach((idStr) => {
          scannedTabs++;
          const tabId = parseInt(idStr, 10);
          const opened = openTimes[idStr];
          if (!opened || now - opened <= THRESHOLD_MS) {
            return;
          }
          eligibleTabs++;
          // Check the tab still exists before attempting to execute a script.
          pending++;
          chrome.tabs.get(tabId, (tab) => {
            if (chrome.runtime.lastError || !tab) {
              // Tab no longer exists; clean up.
              logDebug("Tab missing, cleaning", { tabId, err: chrome.runtime.lastError });
              updateOpenTimes((current) => {
                delete current[idStr];
              }).finally(() => {
                pending--; maybeFinish();
              });
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
                func: () => {
                  const y =
                    window.scrollY ||
                    document.documentElement.scrollTop ||
                    document.body.scrollTop ||
                    0;
                  return y;
                },
              },
              (results) => {
                if (chrome.runtime.lastError) {
                  // Back off retries to avoid repeated errors
                  logDebug("executeScript failed", {
                    tabId,
                    err: chrome.runtime.lastError,
                  });
                  updateOpenTimes((current) => {
                    current[idStr] = Date.now();
                  }).finally(() => {
                    pending--; maybeFinish();
                  });
                  return;
                }
                const scrollPos =
                  results && results[0] && results[0].result != null
                    ? results[0].result
                    : 0;
                if (scrollPos <= 0) {
                  const url = tab.url;
                  const title = tab.title || url;
                  // Close the tab.  This will trigger onRemoved, which cleans
                  // up the openTimes entry.
                  const prev = { windowId: tab.windowId, index: tab.index };
                  chrome.tabs.remove(tabId, () => {
                    const hadError = Boolean(chrome.runtime.lastError);
                    if (hadError) {
                      // Do not record history/badge on failure; keep openTimes to retry later.
                      logDebug("Tab close failed", {
                        tabId,
                        err: chrome.runtime.lastError,
                      });
                      pending--; maybeFinish();
                      return;
                    }
                    // Closing succeeded: clean up and record.
                    logDebug("Tab closed", { tabId, url });
                    updateOpenTimes((current) => {
                      delete current[idStr];
                    });
                    findSessionIdForUrl(url).then((sessionId) => {
                      addToHistory(url, title, { sessionId, prev });
                      incrementBadgeCount();
                      notifyClosed(url, title, { sessionId, prev });
                    }).finally(() => {
                      pending--; maybeFinish();
                    });
                  });
                } else {
                  // Consider read; refresh timer to avoid repeated checks soon.
                  logDebug("Tab read (scrolled)", { tabId, scrollPos });
                  updateOpenTimes((current) => {
                    current[idStr] = Date.now();
                  }).finally(() => {
                    pending--; maybeFinish();
                  });
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
    if (chrome.runtime.lastError) {
      logDebug("Notification create failed", {
        id,
        err: chrome.runtime.lastError,
      });
    }
    const entry = { url, restore: restore || null, ts: Date.now() };
    enqueueUndoMapPut(id, entry);
  });
}
// Email sending removed.

chrome.notifications.onButtonClicked.addListener(
  (notificationId, buttonIndex) => {
    if (buttonIndex !== 0) return;
    updateUndoMap((undoMap) => {
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
    });
  },
);

// Clean up undo entries when the notification is closed/dismissed
chrome.notifications.onClosed.addListener((notificationId) => {
  updateUndoMap((undoMap) => {
    if (undoMap[notificationId]) {
      delete undoMap[notificationId];
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
          resolve();
        });
      });
    }));
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
  updateUndoMap((undoMap) => {
    undoMap[id] = value;
  });
}

function updateUndoMap(mutator) {
  undoWriteChain = undoWriteChain
    .catch(() => {})
    .then(() => new Promise((resolve) => {
      chrome.storage.local.get("undoMap", (data) => {
        const undoMap = data.undoMap || {};
        mutator(undoMap);
        chrome.storage.local.set({ undoMap }, () => {
          if (chrome.runtime.lastError) {
            logDebug("undoMap write failed", chrome.runtime.lastError);
          }
          resolve();
        });
      });
    }));
  return undoWriteChain;
}

function updateOpenTimes(mutator) {
  openTimesWriteChain = openTimesWriteChain
    .catch(() => {})
    .then(() => new Promise((resolve) => {
      chrome.storage.local.get("openTimes", (data) => {
        const openTimes = data.openTimes || {};
        mutator(openTimes);
        chrome.storage.local.set({ openTimes }, () => {
          if (chrome.runtime.lastError) {
            logDebug("openTimes write failed", chrome.runtime.lastError);
          }
          resolve();
        });
      });
    }));
  return openTimesWriteChain;
}
