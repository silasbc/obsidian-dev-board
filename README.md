# Dev Board

[![release-check](https://github.com/cobbenterprises/obsidian-dev-board/actions/workflows/release-check.yml/badge.svg)](https://github.com/cobbenterprises/obsidian-dev-board/actions/workflows/release-check.yml)

A kanban dev-cycle board for [Obsidian](https://obsidian.md), built to be shared with AI agents.

The board is plain JSON in your vault. You work it visually — drag cards through the dev cycle, review shipped work card by card, leave feedback. External writers (an AI coding agent, a script, a runner on another machine) append **event files** next to the board, and the plugin folds them in safely: no lost updates, no sync conflicts, an auditable history on every card. Cards written by your agent while Obsidian was closed are on the board the next time you look.

Plain files first: every card can own a normal Markdown note in your vault (spec, screenshots, feedback trail), and the board record is readable JSON you can grep, diff, and back up.

**New here? Read the [Guide](GUIDE.md)** — a walkthrough for humans *and* agents: how it works, install, configuring it for your vault, and the workflows it enables. Agents wiring themselves to the board read [AGENTS.md](AGENTS.md) for the exact write contract.

![The Dev Board — capture bar, dev-cycle columns, owner/agent chips, session debriefs](docs/board.png)

## The three surfaces

- **Dev Board** (ribbon icon, command palette, or `obsidian://dev-board`) — the kanban board. Quick-capture bar, drag-and-drop columns, search, per-card modal with an embedded editor for the card's note, pasted screenshots, history.
- **Dev Board Review** (`obsidian://dev-board-review`) — a click-through room that works one column card by card: the card + spec + every link on it on the left, the rendered card note on the right, and a route bar (Approve, Needs work with required feedback, Not sold, Reject, one-click Undo). `obsidian://dev-board-triage` opens the same room over the backlog.

  ![The review room — origin and feedback on the left, the rendered card note with Your next step on the right](docs/review.png)

- **Big Board** (`obsidian://dev-board-big`) — a higher-altitude portfolio kanban: initiatives in theme lanes, each linked to its implementation cards with a live "N in flight / M shipped" chip.

  ![The Big Board — initiatives in lanes with live in-flight/shipped counts](docs/big-board.png)

## The dev cycle

The starter board ships with the full flow — trim or rename columns in `board.json`:

**Recommended → Ideas → Prototype → Finalize → Build → Shipped → Reviewed → Lived → Not Sold / Rejected**

- **Recommended** is where an agent's suggestions land, kept separate from your own captures until you promote them.
- **Prototype / Finalize** are the scoping columns: hone what v1 is before anything gets built.
- **Shipped → Reviewed** is the sign-off gate you work in the review room.
- **Lived** is for shipped work that has proven itself in real use.

Every card shows who created it (you or your agent — labels configurable in settings), its subsystem, its age, and the first item of its note's **"Your next step"** section, so the board doubles as a work queue.

## Working with an AI agent

This is the plugin's reason to exist. The full write contract — event schema, reducer semantics, card and note conventions, working example code — is in [AGENTS.md](AGENTS.md). The short version:

1. Your agent writes one JSON event file per card change into `Dev Board/Events/<writer-name>/`.
2. The plugin (or any other reducer following the contract) folds events into per-card records and rewrites `board.json`.
3. Conflicts resolve deterministically: newest event wins fields, history always unions, and a late-arriving older event can never rewind a card.

Point your agent at AGENTS.md and it can file recommendations, move its own work through Build → Shipped, and read your feedback from card notes.

## Install

Until the plugin is in the community directory:

**Manual** — download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/cobbenterprises/obsidian-dev-board/releases) into `<your vault>/.obsidian/plugins/dev-board/`, then enable *Dev Board* in Settings → Community plugins.

**BRAT** — add `cobbenterprises/obsidian-dev-board` in the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin.

On first open the plugin creates `Dev Board/board.json` (and `big_board.json` when you first open the Big Board) with the starter columns. Paths, owner/agent labels, and the subsystem picker are configurable in settings.

## Data layout

```
Dev Board/
  board.json          # columns + reduced card index (the board you see)
  big_board.json      # portfolio lanes, columns, initiatives
  Meeting Notes.md    # optional append-only journal of agent recommendations
  Events/<writer>/    # one JSON file per change, per writer — append-only
  Records/<card>.json # per-card fold of every event ever applied to it
  Cards/              # per-card Markdown notes
  Attachments/        # pasted screenshots
  Debriefs/           # optional per-session review pages
```

Everything is local. The plugin makes no network requests.

## Privacy & security

The plugin contains no telemetry, API client, or background network service. Clicking an external link—or rendering a card note that deliberately embeds a remote Markdown asset—can still ask Obsidian to open or retrieve that resource.

Public releases use a three-door privacy gate: the tracked pre-push hook, `npm run release:check`, and GitHub Actions all run the same scanner over the current tree **and every reachable historical blob**. Binary assets require a SHA-256 entry in `.privacy-assets.json` after original-resolution visual review; PNG/JPEG metadata is rejected. Run `npm run privacy:install-hook` once after cloning this repository.

## License

MIT — see [LICENSE](LICENSE).

## Sifi's edition

This repository is a fork. It keeps the record contract and plugin id exactly as upstream defines them and adds a bootstrap guard for unsynced devices, collapsed empty columns on the desktop, and a viewport-fit review room. See [FORK.md](FORK.md).
