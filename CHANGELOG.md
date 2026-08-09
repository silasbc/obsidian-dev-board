# Changelog

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
3. Scan every reachable Git object, not only the working tree, for private paths, private hostnames, emails, and credential shapes.
4. Attach `main.js`, `manifest.json`, and `styles.css` to the GitHub release whose tag exactly matches the manifest version.
