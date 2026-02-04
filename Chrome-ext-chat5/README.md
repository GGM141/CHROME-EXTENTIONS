# Tab Monitor Closer

Chrome extension that closes unread tabs that have been open beyond a configured timeout.

## What It Does
- Tracks when tabs are opened or navigated.
- Periodically checks tabs that exceed the timeout.
- If a tab has not been scrolled (scroll position at the top), it is considered "unread" and closed.
- Shows a notification with an Undo button.
- Keeps a short history of recently closed tabs (max 50).

## How To Use
1. Open the extension popup.
2. Set the timeout in `HH:MM` format and click `Save`.
3. Optionally click `Run now` to trigger an immediate check.
4. Use the history list in the popup to restore closed tabs.

## Notes
- Pinned and audible tabs are skipped.
- Only `http`/`https` tabs are checked.
- The check frequency is computed from the timeout (roughly quarter of it, with bounds).

