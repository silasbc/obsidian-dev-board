# Dev Board — Sifi's edition

This is Silas's fork of [cobbenterprises/obsidian-dev-board](https://github.com/cobbenterprises/obsidian-dev-board), the Dev Board plugin by Jason Cobb. It runs inside the Ava vault (Select, Sifi's edition) alongside the Media Log fork at silasbc/obsidian-media-log, and is written to by the `silasbc/select` runner through the event contract in `AGENTS.md`.

## Rules

- **The record contract is upstream's, unchanged.** Events in `Dev Board/Events/<writer>/`, full-card snapshots, `Records/` and `board.json` derived. Every writer in the system keeps working against either edition.
- **Plugin id stays `dev-board`.** This edition installs into the same folder and replaces upstream one-for-one.
- **Track upstream.** `upstream` remote is cobbenterprises, `origin` is silasbc. Fork changes are marked `[sifi]` in `src/main.js` and live in one appended section of `styles.css`; merge `upstream/main` regularly.
- **Versions.** Upstream version plus a prerelease suffix (`1.0.0-sifi.1`); `versions.json` maps each to the same `minAppVersion`.
- **Commits.** Upstream's privacy gate scans history for personal email addresses, so this clone commits as the GitHub noreply address; the gate here also allows the AI co-author trailer's public noreply address. That is the only change to `scripts/privacy-gate.mjs`.

## What Sifi's edition adds

1. **Auto-advance to Lived** (owner rule 2026-09-05, "default to lived, review the exceptions"). A card in Testing, Shipped, or Reviewed whose last history entry is older than N days (setting, default 7; 0 off) moves to Lived on its own, as an ordinary event by `dev-board-auto`. Feedback, verdicts, and edits append history and so reset the clock.
2. **Bootstrap guard** (dd-20260831-btsp). A device whose `board.json` has not synced yet (Obsidian Sync skips `.json` unless "Sync all other types" is on) no longer gets a blank starter board written over a real one. With events or records present the reducer rebuilds every card; with only card notes present the board says on screen what it is waiting for and names the fix. `big_board.json`, which is not event-sourced, is left absent in that state rather than scaffolded blank (last writer wins on sync). A clean first run still gets the starter board.
3. **Collapsed empty columns** (dd-20260821-2fqz). On desktop an empty column narrows to a 124px stub with its normal header (no sideways text) so active lanes get the width. It stays a live drop target: dragging over it expands it, a click opens it in place. Setting: "Collapse empty columns", default on. Mobile keeps full columns.
4. **Viewport-fit review room** (dd-20260821-d1vo). The review room fills the window height, the card and note panes scroll inside, and the verdict bar is always on screen. Below 760px it falls back to the page-scroll layout with the sticky bar.

## Build

`npm install`, `npm run build`, `npm run check` (upstream's smoke test, this fork's `scripts/sifi-smoke.cjs`, and the release check). Node 22 works; upstream uses bun, so `package-lock.json` stays out of the repo. This clone has `core.autocrlf=false`.

## Changelog (Sifi's edition)

### 1.0.0-sifi.3 — 2026-09-05

- Auto-advance to Lived after N days with no Doesn't (default 7), with a smoke test for stale, fresh, backlog, and off.

### 1.0.0-sifi.2 — 2026-09-05

- Collapsed columns keep a horizontal header at 124px instead of a 56px sideways label (owner feedback on the Prototype stub).

### 1.0.0-sifi.1 — 2026-09-05

- Forked from upstream 1.0.0. Added the bootstrap guard, collapsed empty columns, and the viewport-fit review room, with `scripts/sifi-smoke.cjs` covering the guard's four states and the Big Board guard.
