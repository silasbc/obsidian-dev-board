# Changelog

## Unreleased

- Replaced the current-tree-only sanitization check with Select's shared public-release privacy gate: every reachable Git blob is scanned, committed-then-deleted leaks fail, binary assets require SHA-256 review attestations, and PNG/JPEG metadata is rejected.
- Added a tracked pre-push hook. Run `npm run privacy:install-hook` once per clone; it runs the same `npm run release:check` command used by GitHub Actions.

## 1.0.0 — 2026-08-09

First public release.

- Kanban dev-cycle board over plain vault JSON: quick capture, drag-and-drop columns, search, per-card modal with an embedded card-note editor, pasted screenshots, per-card history.
- Click-through review room over any column: card + spec + links left, rendered card note right, route bar with Approve / Needs work (feedback required) / Not sold / Reject, undo, and REVERSE-to-Build for shipped work.
- Big Board portfolio view: initiatives in theme lanes linked to implementation cards with live in-flight/shipped counts.
- Conflict-safe record store: external writers append immutable event files; a commutative reducer folds them into per-card records and the board index, so agents and multiple devices never lose updates.
- First-run bootstrap of a starter board with the full dev cycle; paths, owner/agent labels, and subsystem picker configurable in settings.
- External-writer contract documented in AGENTS.md.

Release verification:

1. Run `npm run release:check`.
2. Confirm `git diff --exit-code -- main.js` after the release build is committed.
3. Confirm `npm run privacy:self-test` catches a committed-then-deleted private path; `release:check` enforces the same full-history scan automatically.
4. Attach `main.js`, `manifest.json`, and `styles.css` to the GitHub release whose tag exactly matches the manifest version.
5. Documentation standard (gate-enforced): the release ships `GUIDE.md` — a walkthrough for humans and agents covering how it works, install, vault configuration, and the workflows it enables — and `README.md` embeds current screenshots captured from a sanitized demo vault, never a live one.
