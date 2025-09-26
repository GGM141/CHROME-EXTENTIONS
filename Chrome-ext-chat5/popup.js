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
  });

  // Save HH:MM into separate hours/minutes keys used by background
  byId("save").addEventListener("click", () => {
    const raw = String(field.thresholdHHMM.value || "").trim();
    const m = raw.match(/^(\d{1,3}):([0-5]\d)$/);
    if (!m) {
      statusEl.textContent = "Invalid format. Use HH:MM";
      setTimeout(() => (statusEl.textContent = ""), 1800);
      return;
    }
    const hours = Math.min(999, parseInt(m[1], 10));
    const minutes = parseInt(m[2], 10);
    chrome.storage.sync.set(
      {
        thresholdHours: hours,
        thresholdMinutes: minutes,
      },
      () => {
        statusEl.textContent = (hours === 0 && minutes === 0)
          ? "Saved! Timer disabled; use Run now."
          : "Saved!";
        setTimeout(() => (statusEl.textContent = ""), 1500);
      },
    );
  });

  // Run now: trigger immediate check in background
  byId("runNow").addEventListener("click", () => {
    const btn = byId("runNow");
    btn.disabled = true;
    const prev = statusEl.textContent;
    statusEl.textContent = "Checking...";
    chrome.runtime.sendMessage({ type: "runCheckNow" }, (res) => {
      btn.disabled = false;
      if (res && res.ok) {
        statusEl.textContent = "Check triggered";
      } else {
        statusEl.textContent = "Failed to run";
      }
      setTimeout(() => (statusEl.textContent = prev || ""), 1200);
    });
  });

  // Load history and reset badge on open
  function renderHistory(items) {
      if (!items || !items.length) {
        historyEl.innerHTML = "<em>No items yet.</em>";
        return;
      }
      const html = items
        .map((e, idx) => {
          const d = new Date(e.ts || Date.now());
          const when = d.toLocaleString();
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

  // ===== Gmail UI (launchWebAuthFlow) =====
  const emailEl = byId("notifyEmail");
  const btnConn = byId("btnGmailConnect");
  const btnTest = byId("btnGmailTest");

  // Заполняем поле получателя из sync-хранилища
  if (emailEl) {
    chrome.storage.sync.get("notifyEmail", ({ notifyEmail }) => {
      if (notifyEmail) emailEl.value = notifyEmail;
    });
    emailEl.addEventListener("change", () => {
      chrome.storage.sync.set({ notifyEmail: (emailEl.value || "").trim() });
    });
  }

  // Кнопка «Подключить Gmail» — запускает OAuth поток
  if (btnConn) {
    btnConn.addEventListener("click", () => {
      btnConn.disabled = true;
      const prev = statusEl.textContent;
      statusEl.textContent = "Authorizing...";
      chrome.runtime.sendMessage({ type: "gmail-connect" }, (res) => {
        btnConn.disabled = false;
        if (res && res.ok) {
          statusEl.textContent = "Gmail connected";
        } else {
          statusEl.textContent = `Error: ${(res && res.error) || "failed"}`;
        }
        setTimeout(() => (statusEl.textContent = prev || ""), 1500);
      });
    });
  }

  // Кнопка «Тестовое письмо» — отправляет тест от имени пользователя
  if (btnTest) {
    btnTest.addEventListener("click", () => {
      const to = (emailEl && emailEl.value || "").trim();
      if (!to) {
        statusEl.textContent = "Enter e-mail first";
        setTimeout(() => (statusEl.textContent = ""), 1500);
        return;
      }
      btnTest.disabled = true;
      const prev = statusEl.textContent;
      statusEl.textContent = "Sending test...";
      chrome.runtime.sendMessage({
        type: "gmail-send",
        payload: { to, subject: "Tab Monitor: test", text: "Test message from extension", html: "<b>Test</b> message from extension" }
      }, (res) => {
        btnTest.disabled = false;
        statusEl.textContent = (res && res.ok) ? "Sent" : `Error: ${(res && res.error) || "failed"}`;
        setTimeout(() => (statusEl.textContent = prev || ""), 1500);
      });
    });
  }
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
