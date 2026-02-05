# Tab Monitor Closer

Chrome extension that closes unread tabs after a configurable timeout and can optionally notify you via Gmail or Telegram, plus export an HTML log of closed tabs.

## Overview
- Tracks tab open time and lightweight activity (scroll, clicks, input) to decide whether a tab is read.
- Closes tabs that stay unread beyond the timeout.
- Shows a notification with an Undo button when a tab is closed.
- Keeps a short local history (max 50) for quick restore.
- Optional Gmail/Telegram notifications and an HTML log export.

## Install (development)
1. Open `chrome://extensions` (or `edge://extensions`) and enable Developer mode.
2. Click "Load unpacked" and select this project folder.
3. Open the extension popup to configure settings.

## Popup UI
- Timeout (HH:MM): The threshold after which a tab becomes eligible for closing.
- Save: Persists the timeout.
- Run check: Triggers an immediate check.
- Gmail: Connect Gmail and send notifications.
- Telegram: Configure bot token and chat ID for notifications.
- HTML Log: Export a saved list of closed tabs as an HTML file in Downloads.

## HTML Log
- File name (`logFileName`): The base name for the HTML log file (default `closed-tabs.html`).
- Choose or create file: Opens the Save As flow when enabled.
- Export now: Generates the aggregated HTML log immediately.
- Export on close (`logExportOnClose`): When enabled (default true), a new aggregated HTML file is generated each time a tab is closed as unread.
- Save As every time (`logSaveAsEveryTime`): When enabled, each export uses a Save As dialog. Otherwise the file is overwritten in Downloads.

## History and Restore
- Recent closed tabs are stored in `chrome.storage.local.closedHistory`.
- Each entry can be restored from the popup.
- System notifications include an Undo button when a tab is closed.

## Storage Keys (summary)
- chrome.storage.sync:
  - thresholdHours, thresholdMinutes
  - notifyEmail
  - tgToken, tgChatId
  - logFileName
  - logSaveAsEveryTime
  - logExportOnClose
- chrome.storage.local:
  - openTimes
  - closedHistory
  - htmlLogEntries
  - undoMap
  - badgeCount

## Popup <-> Background Messages
- getClosedHistory
- runCheckNow
- resetBadge
- clearHistory
- restoreClosed (index)
- gmail-connect / gmail-send
- telegram-send
- exportHtmlNow
- saveAsLogFile (suggestedName)

## Logging and Downloads
- Each closed tab is added to `htmlLogEntries`.
- If Export on close is enabled, the extension regenerates a single aggregated HTML file and downloads it (overwrite) into Downloads.
- Downloads permission is required and always enabled in this build.

## Debugging
- Use the Run check and Export now buttons for manual testing.
- Check the background service worker console for logs and errors.

## Permissions
- tabs, storage, alarms, scripting, notifications, sessions, identity, downloads
- host permissions: http://*/*, https://*/*, https://gmail.googleapis.com/*

## Notes
- Chrome extensions cannot write arbitrary files directly without a Save As flow. The HTML log is therefore downloaded into the Downloads folder.
