// Popup script for Tab Monitor Closer.
//
// Configure thresholds, view history, and (optionally) send email via Gmail OAuth (launchWebAuthFlow).

document.addEventListener("DOMContentLoaded", () => {
  const byId = (id) => document.getElementById(id);
  const statusEl = byId("status");
  const historyEl = byId("history");

  const field = {
    thresholdHHMM: byId("thresholdHHMM"),
    logFileName: byId("logFileName"),
  };

  // Load existing timeout (hours + minutes) and show as HH:MM
  chrome.storage.sync.get(["thresholdHours", "thresholdMinutes"], (cfg) => {
    const hours = Number.isFinite(Number(cfg.thresholdHours))
      ? Number(cfg.thresholdHours)
      : 24;
    const minutes = Number.isFinite(Number(cfg.thresholdMinutes))
      ? Math.max(0, Number(cfg.thresholdMinutes))
      : 0;
    const hh = String(hours);
    const mm = String(minutes).padStart(2, "0");
    field.thresholdHHMM.value = `${hh}:${mm}`;
  byId("save").addEventListener("click", () => {
    chrome.storage.sync.set(
    const prev = statusEl.textContent;
          const title = (e.title && e.title.trim()) || e.url;
          const safeTitle = title.replace(/</g, "&lt;").replace(/>/g, "&gt;");
          const safeUrl = e.url.replace(/</g, "&lt;").replace(/>/g, "&gt;");
          return `
          <div style="display:flex; gap:6px; align-items:center; margin:6px 0;">
            <div style="flex:1; min-width:0;">
              <div style="font-weight:bold; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${safeTitle}">${safeTitle}</div>
              <div style="font-size:12px; color:#666; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${safeUrl}">${safeUrl}</div>
              <div style="font-size:11px; color:#888;">${when}</div>
            </div>
            <div style="display:flex; gap:6px;">
              <button data-idx="${idx}" class="restore">Restore</button>
            </div>
          </div>`;
        })
        .join("");
      historyEl.innerHTML = html;
      historyEl.querySelectorAll("button.restore").forEach((btn) => {
        btn.addEventListener("click", () => {
          const idx = Number(btn.getAttribute("data-idx"));
          btn.disabled = true;
          chrome.runtime.sendMessage(
            { type: "restoreClosed", index: idx },
            (res) => {
              btn.disabled = false;
              if (!res || !res.ok) {
                statusEl.textContent = "Restore failed";
                setTimeout(() => (statusEl.textContent = ""), 1500);
              } else {
                // Refresh history to reflect removal
                chrome.runtime.sendMessage(
                  { type: "getClosedHistory" },
                  (r) => {
                    if (r && r.ok) renderHistory(r.history || []);
                  },
                );
              }
            },
          );
        });
      });
      // No domain settings in simplified UI.
    }

  chrome.runtime.sendMessage({ type: "getClosedHistory" }, (res) => {
    if (res && res.ok) renderHistory(res.history || []);
    else historyEl.textContent = "Failed to load history";
  });
  chrome.runtime.sendMessage({ type: "resetBadge" }, () => {});

  byId("clearHistory").addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "clearHistory" }, (res) => {
      if (res && res.ok) renderHistory([]);
    });
  });

  // ===== /Gmail UI =====
  // ===== Telegram UI =====
  const tgTokenEl = byId("tgToken");
  const tgChatIdEl = byId("tgChatId");
  const btnTgTest = byId("btnTgTest");

  if (tgTokenEl || tgChatIdEl) {
    chrome.storage.sync.get(["tgToken", "tgChatId"], ({ tgToken, tgChatId }) => {
      if (tgTokenEl && tgToken) tgTokenEl.value = tgToken;
      if (tgChatIdEl && tgChatId) tgChatIdEl.value = tgChatId;
    });
    if (tgTokenEl) tgTokenEl.addEventListener("change", () => {
      chrome.storage.sync.set({ tgToken: (tgTokenEl.value || "").trim() });
    });
    if (tgChatIdEl) tgChatIdEl.addEventListener("change", () => {
      chrome.storage.sync.set({ tgChatId: (tgChatIdEl.value || "").trim() });
    });
  }

  if (btnTgTest) {
    btnTgTest.addEventListener("click", () => {
      const token = (tgTokenEl && tgTokenEl.value || "").trim();
      const chatId = (tgChatIdEl && tgChatIdEl.value || "").trim();
      if (!token || !chatId) {
        statusEl.textContent = "Enter Telegram token and chat ID";
        setTimeout(() => (statusEl.textContent = ""), 1800);
        return;
      }
      btnTgTest.disabled = true;
      const prev = statusEl.textContent;
      statusEl.textContent = "Sending to Telegram...";
      chrome.runtime.sendMessage({
        type: "telegram-send",
        payload: { text: "<b>Test</b> message from Tab Monitor Closer" }
      }, (res) => {
        btnTgTest.disabled = false;
        statusEl.textContent = (res && res.ok) ? "Sent to Telegram" : `Error: ${(res && res.error) || "failed"}`;
        setTimeout(() => (statusEl.textContent = prev || ""), 1500);
      });
    });
  }
  // ===== HTML Log UI =====
  const logFileNameEl = byId('logFileName');
  const btnChooseLogFile = byId('btnChooseLogFile');
  const btnResetLogFile = byId('btnResetLogFile');
  const logFilePathDisplay = byId('logFilePathDisplay');
  const logFileStatus = byId('logFileStatus');

  // Load saved filename/path
  chrome.storage.sync.get(['logFileName', 'logAutoSave'], (cfg) => {
    if (cfg.logFileName) logFileNameEl.value = cfg.logFileName;
    if (cfg.logFileName) logFilePathDisplay.textContent = cfg.logFileName;
  });

  // Let user pick a filename (note: Chrome extensions can't open arbitrary file pickers; we'll request downloads permission and save to Downloads)
  if (btnChooseLogFile) {
    btnChooseLogFile.addEventListener('click', async () => {
      // Request downloads permission if not present
      if (chrome.permissions) {
        const ok = await new Promise((res) => chrome.permissions.request({ permissions: ['downloads'] }, (granted) => res(Boolean(granted))));
        if (!ok) {
          logFileStatus.textContent = 'Downloads permission is required to save interactively.';
          setTimeout(() => (logFileStatus.textContent = ''), 3000);
          return;
        }
      }

      const suggested = (logFileNameEl.value && logFileNameEl.value.trim()) || 'closed-tabs.html';
      btnChooseLogFile.disabled = true;
      logFileStatus.textContent = 'Opening Save As...';
      // Determine desired mode from Save As toggle
      const saveAsMode = Boolean(byId('chkSaveAsEveryTime') && byId('chkSaveAsEveryTime').checked);
      const msg = saveAsMode ? { type: 'saveAsLogFile', suggestedName: suggested } : { type: 'exportHtmlNow' };
      chrome.runtime.sendMessage(msg, (res) => {
        btnChooseLogFile.disabled = false;
        if (res && res.ok) {
          if (res.filename) {
            logFilePathDisplay.textContent = `Saved: ${res.filename}`;
            logFileNameEl.value = res.filename;
          }
          logFileStatus.textContent = saveAsMode ? 'Save dialog closed. If you saved, filename will be stored.' : 'Exported (overwrite) to Downloads.';
        } else {
          logFileStatus.textContent = `Save failed: ${(res && res.error) || 'unknown'}`;
        }
        setTimeout(() => (logFileStatus.textContent = ''), 2500);
      });
    });
  }

  if (btnResetLogFile) {
    btnResetLogFile.addEventListener('click', () => {
      chrome.storage.sync.remove(['logFileName'], () => {
        logFileNameEl.value = '';
        logFilePathDisplay.textContent = 'File not set.';
        logFileStatus.textContent = 'Setting cleared';
        setTimeout(() => (logFileStatus.textContent = ''), 1200);
      });
    });
  }
  // Downloads permission indicator and request button
  const permIndicator = byId('permIndicator');
  const btnRequestDownloads = byId('btnRequestDownloads');
  async function refreshDownloadsPerm() {
    if (!chrome.permissions) return;
    chrome.permissions.contains({ permissions: ['downloads'] }, (has) => {
      permIndicator.textContent = has ? 'granted' : 'not granted';
    });
  }
  if (btnRequestDownloads) {
    btnRequestDownloads.addEventListener('click', async () => {
      if (!chrome.permissions) return;
      btnRequestDownloads.disabled = true;
      const granted = await new Promise((res) => chrome.permissions.request({ permissions: ['downloads'] }, (g) => res(Boolean(g))));
      btnRequestDownloads.disabled = false;
      refreshDownloadsPerm();
      if (!granted) {
        logFileStatus.textContent = 'Downloads permission required.';
        setTimeout(() => (logFileStatus.textContent = ''), 1800);
      }
    });
  }
  refreshDownloadsPerm();

  // Save As toggle: persist in sync
  const chkSaveAs = byId('chkSaveAsEveryTime');
  if (chkSaveAs) {
    chrome.storage.sync.get('logSaveAsEveryTime', (cfg) => {
      chkSaveAs.checked = Boolean(cfg.logSaveAsEveryTime);
    });
    chkSaveAs.addEventListener('change', () => {
      chrome.storage.sync.set({ logSaveAsEveryTime: Boolean(chkSaveAs.checked) });
    });
  }
  // Export on close toggle: default true
  const chkExportOnClose = byId('chkExportOnClose');
  if (chkExportOnClose) {
    chrome.storage.sync.get('logExportOnClose', (cfg) => {
      const v = cfg.logExportOnClose;
      chkExportOnClose.checked = (v == null) ? true : Boolean(v);
    });
    chkExportOnClose.addEventListener('change', () => {
      chrome.storage.sync.set({ logExportOnClose: Boolean(chkExportOnClose.checked) });
    });
  }
  // Export now button: request background to write aggregated HTML and download it.
  const btnExportHtml = byId('btnExportHtml');
  if (btnExportHtml) {
    btnExportHtml.addEventListener('click', () => {
      btnExportHtml.disabled = true;
      const prev = logFileStatus.textContent;
      logFileStatus.textContent = 'Exporting...';
      const saveAsMode = Boolean(byId('chkSaveAsEveryTime') && byId('chkSaveAsEveryTime').checked);
      const msg = saveAsMode ? { type: 'saveAsLogFile', suggestedName: (logFileNameEl.value && logFileNameEl.value.trim()) || 'closed-tabs.html' } : { type: 'exportHtmlNow' };
      chrome.runtime.sendMessage(msg, (res) => {
        btnExportHtml.disabled = false;
        if (res && res.ok) {
          if (res.filename) {
            logFilePathDisplay.textContent = `Saved: ${res.filename}`;
            logFileNameEl.value = res.filename;
          }
          logFileStatus.textContent = 'Export complete — check Downloads.';
        } else {
          logFileStatus.textContent = `Export failed: ${(res && res.error) || 'unknown'}`;
        }
        setTimeout(() => (logFileStatus.textContent = prev || ''), 2500);
      });
    });
  }
  // ===== /Telegram UI =====
});
