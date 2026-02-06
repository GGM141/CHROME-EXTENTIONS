# Tab Monitor Closer

Tab Monitor Closer automatically closes unread tabs after a user-defined timeout. It uses lightweight activity signals (scroll and interaction) to avoid closing tabs you've already read. Optional Gmail and Telegram notifications and an HTML log export are available.

## Features
- Auto-close unread tabs after a configurable timeout.
- Activity-aware detection (scroll and interaction checks).
- Undo notifications when a tab is closed.
- Recent closed tabs history with one-click restore.
- Batch window to group notifications/log exports for rapid closures.
- Optional Gmail notifications (OAuth via Chrome identity).
- Optional Telegram bot notifications.
- HTML log export of closed tabs (aggregated file in Downloads).

## Privacy & Data Handling
- All tab metadata is processed locally in the browser.
- Settings are stored in `chrome.storage.sync` and local history in `chrome.storage.local`.
- Gmail and Telegram notifications are optional and only used when configured by the user.
- No data is sent to any server by default.
- HTML log export is saved locally to Downloads.

Permissions rationale (high-level):
- `tabs`, `scripting`, `storage`, `alarms`, `notifications`, `sessions`: core tab tracking, closing, undo, and persistence.
- `identity`: OAuth sign-in for Gmail notifications.
- `downloads`: saving the aggregated HTML log.

## Install (development)
1. Open `chrome://extensions` (or `edge://extensions`) and enable **Developer mode**.
2. Click **Load unpacked** and select this project folder.
3. Open the extension popup to configure settings.

## Usage
- **Timeout (HH:MM):** set a threshold for closing unread tabs.
- **Batch window (min):** group Gmail/Telegram notifications and HTML log exports for tabs closed close in time (default 1 minute).
- **Save:** apply the timeout.
- **Run check:** trigger a scan immediately.
- **Undo:** use the notification button or restore from history.
- **HTML Log:** export an aggregated list of closed tabs to Downloads.

## Screenshots
> Add screenshots here. Suggested names:
> - `screenshots/popup-main.png`
> - `screenshots/popup-gmail.png`
> - `screenshots/popup-telegram.png`
> - `screenshots/popup-log.png`

Example:
```
![Main popup](screenshots/popup-main.png)
```

## Storage Keys (summary)
- `chrome.storage.sync`
  - `thresholdHours`, `thresholdMinutes`
  - `batchWindowMinutes`
  - `notifyEmail`
  - `tgToken`, `tgChatId`
  - `logFileName`
  - `logSaveAsEveryTime`
  - `logExportOnClose`
- `chrome.storage.local`
  - `openTimes`
  - `closedHistory`
  - `htmlLogEntries`
  - `undoMap`
  - `badgeCount`

## Popup <-> Background Messages
- `getClosedHistory`
- `runCheckNow`
- `resetBadge`
- `clearHistory`
- `restoreClosed` (index)
- `gmail-connect` / `gmail-send`
- `telegram-send`
- `exportHtmlNow`
- `saveAsLogFile` (suggestedName)

## Troubleshooting
- If the service worker fails to start, check the background console in `chrome://extensions`.
- If Gmail auth fails, verify the OAuth client configuration.

## License
Add your preferred license here.
