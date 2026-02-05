# CHANGELOG - branch `copilot`

This is a short summary of the latest commits in branch `copilot` (hash, date, message). It is meant as a quick overview of changes related to HTML export and popup UI.

## Current changes
- feat: batch Gmail/Telegram/HTML export into a single message/save when several tabs close within a short window.
- fix: improved Telegram response handling (`safeJson`) and downloads permission UI.
- refactor: cache `logExportOnClose` and reduce chrome.storage.sync reads.
- ui: improved popup field defaults and file name display.

## Recent commits

### Features (feat)
- 6cffc81 - 2025-09-26 - ui: add warning for Export on close, move inline styles to CSS, show saved filename in UI
- b4aa7b2 - 2025-09-26 - feat: add Export on close toggle (manual-only option to avoid automatic downloads)
- 1f2ed5d - 2025-09-26 - feat(popup): show downloads permission status and add Save As toggle (persisted)
- f96ed24 - 2025-09-26 - feat: interactive Save As flow for HTML log (saveAs:true) and persist chosen filename
- 5844e4c - 2025-09-26 - feat(popup): add 'Export now' button and background handler to export aggregated HTML log
- 2e4efe1 - 2025-09-26 - feat: HTML log of closed tabs (configurable filename, downloads permission, aggregated export)
- 5fad0e6 - 2025-09-10 - feat: improve tab activity detection
- 7261c38 - 2025-09-09 - feat: Telegram notifications via fetch, Gmail OAuth, timer-off at 00:00, and UI hints
- dd882b9 - 2025-09-08 - feat: Gmail OAuth (email sending) improvements

### Chores (chore)
- 5c0497d - 2025-09-26 - chore(popup): add lang and viewport meta for HTML validity

### Other / Infra
- 4902fb6 - 2025-09-08 - add identity + gmail.googleapis.com host_permission via patch
- 20798ca - 2025-09-07 - add Tab Monitor Closer Chrome extension with icons, manifest, popup, and background functionality

## Notes
- This is a brief log. For full commit history, use `git log` in the local repo.
- Entry format: `<short-hash> - <date> - <commit message>`.

If you need, I can:
- generate a Conventional Commits grouped changelog,
- add links to PRs or issues (if available),
- expand the list with full commit messages and authors.
