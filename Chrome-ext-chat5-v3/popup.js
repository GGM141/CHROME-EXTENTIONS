// Popup script for Tab Monitor Closer.
//
// Configure thresholds, review history, manage Gmail/Telegram notifications,
// and control HTML log export behavior from the popup UI.

document.addEventListener("DOMContentLoaded", () => {
  const byId = (id) => document.getElementById(id);
  const statusEl = byId("status");
  const historyEl = byId("history");

  const thresholdEl = byId("thresholdHHMM");
  const saveBtn = byId("save");
  const runNowBtn = byId("runNow");
  const clearHistoryBtn = byId("clearHistory");

  const notifyEmailEl = byId("notifyEmail");
  const gmailStatusEl = byId("gmailStatus");
  const btnGmailConnect = byId("btnGmailConnect");
  const btnGmailSignOut = byId("btnGmailSignOut");
  const btnGmailTest = byId("btnGmailTest");

  const tgTokenEl = byId("tgToken");
  const tgChatIdEl = byId("tgChatId");
  const btnTgTest = byId("btnTgTest");

  const logFileNameEl = byId("logFileName");
  const logFilePathDisplay = byId("logFilePathDisplay");
  const logFileStatus = byId("logFileStatus");
  const btnChooseLogFile = byId("btnChooseLogFile");
  const btnResetLogFile = byId("btnResetLogFile");
  const btnExportHtml = byId("btnExportHtml");
  const permIndicator = byId("permIndicator");
  const btnRequestDownloads = byId("btnRequestDownloads");
  const chkSaveAsEveryTime = byId("chkSaveAsEveryTime");
  const chkExportOnClose = byId("chkExportOnClose");

  const sendMessage = (message) =>
    new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (resp) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(resp || { ok: false, error: "No response" });
        }
      });
    });

  const flashStatus = (text, timeout = 2000) => {
    if (!statusEl) return;
    statusEl.textContent = text || "";
    if (timeout > 0) {
      setTimeout(() => {
        if (statusEl.textContent === text) statusEl.textContent = "";
      }, timeout);
    }
  };

  const escapeHtml = (str) =>
    String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

  const parseThreshold = (value) => {
    if (!value) return null;
    const match = /^(\d{1,3}):([0-5]\d)$/.exec(value.trim());
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
    return { hours, minutes };
  };

  const populateInitialFields = () => {
    chrome.storage.sync.get(
      [
        "thresholdHours",
        "thresholdMinutes",
        "notifyEmail",
        "tgToken",
        "tgChatId",
        "logFileName",
        "logSaveAsEveryTime",
        "logExportOnClose"
      ],
      (cfg) => {
        const hours = Number.isFinite(Number(cfg.thresholdHours))
          ? Number(cfg.thresholdHours)
          : 24;
        const minutes = Number.isFinite(Number(cfg.thresholdMinutes))
          ? Math.max(0, Number(cfg.thresholdMinutes))
          : 0;
        if (thresholdEl) {
          const hh = String(hours);
          const mm = String(minutes).padStart(2, "0");
          thresholdEl.value = `${hh}:${mm}`;
        }

        if (notifyEmailEl) {
          notifyEmailEl.value = cfg.notifyEmail ? String(cfg.notifyEmail) : "";
        }

        if (tgTokenEl) tgTokenEl.value = cfg.tgToken ? String(cfg.tgToken) : "";
        if (tgChatIdEl) tgChatIdEl.value = cfg.tgChatId ? String(cfg.tgChatId) : "";

        if (logFileNameEl) {
          const fileName = cfg.logFileName ? String(cfg.logFileName) : "";
          logFileNameEl.value = fileName;
          if (logFilePathDisplay) {
            logFilePathDisplay.textContent = fileName || "File not set.";
          }
        } else if (logFilePathDisplay) {
          logFilePathDisplay.textContent = cfg.logFileName ? String(cfg.logFileName) : "File not set.";
        }
        if (chkSaveAsEveryTime) {
          chkSaveAsEveryTime.checked = Boolean(cfg.logSaveAsEveryTime);
        }
        if (chkExportOnClose) {
          const v = cfg.logExportOnClose;
          chkExportOnClose.checked = v == null ? true : Boolean(v);
        }
      }
    );
  };

  const renderHistory = (list) => {
    if (!historyEl) return;
    if (!Array.isArray(list) || list.length === 0) {
      historyEl.innerHTML = "<p>No closed tabs yet.</p>";
      return;
    }
    const now = Date.now();
    const html = list
      .map((entry, idx) => {
        const age = now - (entry.ts || 0);
        const when =
          age < 60000
            ? "just now"
            : age < 3600000
            ? `${Math.floor(age / 60000)}m ago`
            : new Date(entry.ts || Date.now()).toLocaleString();
        const title = (entry.title && entry.title.trim()) || entry.url || "";
        const safeTitle = escapeHtml(title);
        const safeUrl = escapeHtml(entry.url || "");
        return `
        <div class="history-row" style="display:flex; gap:6px; align-items:center; margin:6px 0;">
          <div style="flex:1; min-width:0;">
            <div style="font-weight:bold; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${safeTitle}">${safeTitle}</div>
            <div style="font-size:12px; color:#666; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${safeUrl}">${safeUrl}</div>
            <div style="font-size:11px; color:#888;">${escapeHtml(when)}</div>
          </div>
          <div>
            <button data-idx="${idx}" class="restore">Restore</button>
          </div>
        </div>`;
      })
      .join("");
    historyEl.innerHTML = html;
    historyEl.querySelectorAll("button.restore").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const idx = Number(btn.getAttribute("data-idx"));
        btn.disabled = true;
        const res = await sendMessage({ type: "restoreClosed", index: idx });
        btn.disabled = false;
        if (!res || !res.ok) {
          flashStatus(`Restore failed: ${(res && res.error) || "unknown"}`, 2000);
        }
        await refreshHistory();
      });
    });
  };

  const refreshHistory = async () => {
    const res = await sendMessage({ type: "getClosedHistory" });
    if (res && res.ok) {
      renderHistory(res.history || []);
    } else if (historyEl) {
      historyEl.textContent = "Failed to load history.";
    }
  };

  const refreshDownloadsPerm = () => {
    if (!permIndicator) return;

    const markGranted = () => {
      permIndicator.textContent = "enabled";
      if (btnRequestDownloads) {
        btnRequestDownloads.disabled = true;
        btnRequestDownloads.textContent = "Permission enabled";
      }
    };

    if (!chrome.permissions || !chrome.permissions.contains) {
      markGranted();
      return;
    }

    chrome.permissions.contains(
      { permissions: ["downloads"] },
      (enabled) => {
        if (chrome.runtime.lastError) {
          markGranted();
          return;
        }
        permIndicator.textContent = enabled ? "enabled" : "not enabled";
        if (enabled && btnRequestDownloads) {
          btnRequestDownloads.disabled = true;
          btnRequestDownloads.textContent = "Permission enabled";
        }
      }
    );
  };

  const updateGmailStatus = async () => {
    if (!gmailStatusEl) return;
    gmailStatusEl.textContent = "Checking Gmail status...";
    const res = await sendMessage({ type: "gmail-status" });
    const ok = Boolean(res && res.ok && res.signedIn);
    if (ok) {
      const email = res.email ? `Connected as: ${res.email}` : "Gmail connected";
      gmailStatusEl.textContent = email;
    } else {
      gmailStatusEl.textContent = res && res.error
        ? `Not connected (${res.error})`
        : "Not connected to Gmail";
    }
    if (btnGmailTest) btnGmailTest.disabled = !ok;
    if (btnGmailSignOut) btnGmailSignOut.disabled = !ok;
  };

  // Threshold save handler
  if (saveBtn && thresholdEl) {
    saveBtn.addEventListener("click", () => {
      const parsed = parseThreshold(thresholdEl.value);
      if (!parsed) {
        flashStatus("Invalid time format. Use HH:MM", 2000);
        return;
      }
      chrome.storage.sync.set(
        {
          thresholdHours: parsed.hours,
          thresholdMinutes: parsed.minutes
        },
        () => {
          flashStatus("Settings saved", 1500);
          chrome.runtime.sendMessage({ type: "resetBadge" }, () => {});
        }
      );
    });
  }

  if (runNowBtn) {
    runNowBtn.addEventListener("click", async () => {
      runNowBtn.disabled = true;
      const res = await sendMessage({ type: "runCheckNow" });
      runNowBtn.disabled = false;
      if (res && res.ok) {
        flashStatus("Check started", 1500);
      } else {
        flashStatus(`Failed to start: ${(res && res.error) || "unknown"}`, 2000);
      }
    });
  }

  if (clearHistoryBtn) {
    clearHistoryBtn.addEventListener("click", async () => {
      clearHistoryBtn.disabled = true;
      const res = await sendMessage({ type: "clearHistory" });
      clearHistoryBtn.disabled = false;
      if (res && res.ok) {
        await refreshHistory();
        flashStatus("History cleared", 1500);
      } else {
        flashStatus(`Failed: ${(res && res.error) || "unknown"}`, 2000);
      }
    });
  }

  // Gmail UI wiring
  if (notifyEmailEl) {
    notifyEmailEl.addEventListener("change", () => {
      const value = (notifyEmailEl.value || "").trim();
      chrome.storage.sync.set({ notifyEmail: value || "" });
    });
  }

  if (btnGmailConnect) {
    btnGmailConnect.addEventListener("click", async () => {
      btnGmailConnect.disabled = true;
      if (gmailStatusEl) gmailStatusEl.textContent = "Authorizing Gmail...";
      const res = await sendMessage({ type: "gmail-connect" });
      btnGmailConnect.disabled = false;
      if (res && res.ok) {
        await updateGmailStatus();
      } else {
        gmailStatusEl.textContent = `Authorization failed: ${(res && res.error) || "unknown"}`;
      }
    });
  }

  if (btnGmailSignOut) {
    btnGmailSignOut.addEventListener("click", async () => {
      btnGmailSignOut.disabled = true;
      const res = await sendMessage({ type: "gmail-signOut" });
      if (!(res && res.ok) && gmailStatusEl) {
        gmailStatusEl.textContent = `Failed to sign out: ${(res && res.error) || "unknown"}`;
      }
      await updateGmailStatus();
    });
  }

  if (btnGmailTest) {
    btnGmailTest.addEventListener("click", async () => {
      const to = (notifyEmailEl && notifyEmailEl.value || "").trim();
      if (!to) {
        flashStatus("Enter recipient email first", 2000);
        return;
      }
      btnGmailTest.disabled = true;
      const res = await sendMessage({
        type: "gmail-send",
        payload: {
          to,
          subject: "Tab Monitor Closer: test",
          body: "Test message from the Tab Monitor Closer extension."
        }
      });
      btnGmailTest.disabled = false;
      if (res && res.ok) {
        flashStatus("Test email sent", 2000);
      } else {
        flashStatus(`Send failed: ${(res && res.error) || "unknown"}`, 2500);
      }
    });
  }

  // Telegram UI
  if (tgTokenEl) {
    tgTokenEl.addEventListener("change", () => {
      chrome.storage.sync.set({ tgToken: (tgTokenEl.value || "").trim() });
    });
  }
  if (tgChatIdEl) {
    tgChatIdEl.addEventListener("change", () => {
      chrome.storage.sync.set({ tgChatId: (tgChatIdEl.value || "").trim() });
    });
  }
  if (btnTgTest) {
    btnTgTest.addEventListener("click", async () => {
      const token = (tgTokenEl && tgTokenEl.value || "").trim();
      const chatId = (tgChatIdEl && tgChatIdEl.value || "").trim();
      if (!token || !chatId) {
        flashStatus("Enter Telegram token and chat ID", 2000);
        return;
      }
      btnTgTest.disabled = true;
      flashStatus("Sending to Telegram...", 1500);
      const res = await sendMessage({
        type: "telegram-send",
        payload: { text: "<b>Test</b> message from Tab Monitor Closer" }
      });
      btnTgTest.disabled = false;
      if (res && res.ok) {
        flashStatus("Sent to Telegram", 2000);
      } else {
        flashStatus(`Telegram error: ${(res && res.error) || "failed"}`, 2500);
      }
    });
  }

  // HTML Log UI
  const setLogStatus = (text, timeout = 2500) => {
    if (!logFileStatus) return;
    logFileStatus.textContent = text || "";
    if (timeout > 0) {
      setTimeout(() => {
        if (logFileStatus.textContent === text) logFileStatus.textContent = "";
      }, timeout);
    }
  };

  if (btnChooseLogFile) {
    btnChooseLogFile.addEventListener("click", async () => {
      const suggested =
        (logFileNameEl && logFileNameEl.value && logFileNameEl.value.trim()) ||
        "closed-tabs.html";
      btnChooseLogFile.disabled = true;
      setLogStatus("Opening Save As...", 3000);
      const res = await sendMessage({
        type: "saveAsLogFile",
        suggestedName: suggested
      });
      btnChooseLogFile.disabled = false;
      if (res && res.ok) {
        if (res.filename && logFilePathDisplay) {
          logFilePathDisplay.textContent = res.filename;
        }
        if (logFileNameEl && res.filename) {
          logFileNameEl.value = res.filename;
        }
        setLogStatus("Save dialog completed.");
      } else {
        setLogStatus(`Save failed: ${(res && res.error) || "unknown"}`, 2500);
      }
    });
  }

  if (btnResetLogFile) {
    btnResetLogFile.addEventListener("click", () => {
      chrome.storage.sync.remove(["logFileName"], () => {
        if (logFileNameEl) logFileNameEl.value = "";
        if (logFilePathDisplay) logFilePathDisplay.textContent = "File not set.";
        setLogStatus("Setting cleared", 1800);
      });
    });
  }

  if (btnExportHtml) {
    btnExportHtml.addEventListener("click", async () => {
      btnExportHtml.disabled = true;
      setLogStatus("Exporting...", 3000);
      const saveAs = Boolean(chkSaveAsEveryTime && chkSaveAsEveryTime.checked);
      const msg = saveAs
        ? {
            type: "saveAsLogFile",
            suggestedName:
              (logFileNameEl && logFileNameEl.value && logFileNameEl.value.trim()) ||
              "closed-tabs.html"
          }
        : { type: "exportHtmlNow" };
      const res = await sendMessage(msg);
      btnExportHtml.disabled = false;
      if (res && res.ok) {
        if (res.filename && logFilePathDisplay) {
          logFilePathDisplay.textContent = res.filename;
        }
        if (logFileNameEl && res.filename) {
          logFileNameEl.value = res.filename;
        }
        setLogStatus("Export complete - check Downloads.");
      } else {
        setLogStatus(`Export failed: ${(res && res.error) || "unknown"}`, 2500);
      }
    });
  }

  if (btnRequestDownloads) {
    btnRequestDownloads.addEventListener("click", () => {
      btnRequestDownloads.disabled = true;
      setLogStatus("Downloads permission is required and always enabled in this build.", 3000);
      refreshDownloadsPerm();
    });
  }

  if (chkSaveAsEveryTime) {
    chkSaveAsEveryTime.addEventListener("change", () => {
      chrome.storage.sync.set({
        logSaveAsEveryTime: Boolean(chkSaveAsEveryTime.checked)
      });
    });
  }

  if (chkExportOnClose) {
    chkExportOnClose.addEventListener("change", () => {
      chrome.storage.sync.set({
        logExportOnClose: Boolean(chkExportOnClose.checked)
      });
    });
  }

  populateInitialFields();
  refreshHistory();
  sendMessage({ type: "resetBadge" });
  refreshDownloadsPerm();
  updateGmailStatus();
});
