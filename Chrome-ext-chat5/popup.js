// Popup script for Tab Monitor Closer.
//
// Configure thresholds and domain rules. Email sending has been removed.

document.addEventListener("DOMContentLoaded", () => {
  const byId = (id) => document.getElementById(id);
  const statusEl = byId("status");
  const historyEl = byId("history");

  const field = {
    thresholdHHMM: byId("thresholdHHMM"),
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
        statusEl.textContent = "Saved!";
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

  // No native host - only SmtpJS, so no extra toggles here.
});
