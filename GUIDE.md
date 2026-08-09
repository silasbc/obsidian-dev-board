# Dev Board — the guide

This walkthrough is written for two readers at once: a person setting up Dev Board in their vault, and an AI agent that has been pointed at this repository and asked to work with (or administer) the board. Everything here is true of version 1.0.0. The companion [AGENTS.md](AGENTS.md) is the precise write contract; this guide is the *why and how around it*.

## How it works

Dev Board is three Obsidian views over two plain-JSON records in your vault:

```
Dev Board/
  board.json          # columns + cards — the kanban you see
  big_board.json      # lanes + initiatives — the portfolio altitude
  Events/<writer>/    # append-only change events (how external writers write)
  Records/<card>.json # per-card fold of applied events (derived)
  Cards/              # one optional Markdown note per card
  Meeting Notes.md    # optional append-only recommendation journal
  Debriefs/           # optional per-session review pages
```

The important design decision: **`board.json` is derived state, and events are the write path.** When anything — the plugin on your laptop, the plugin on your phone, an AI agent on a server — changes a card, it appends one immutable event file under `Events/<writer>/`. A commutative reducer folds events into per-card records and rewrites `board.json`. Because the merge is deterministic (newest event wins fields, history always unions, late-arriving older events can never rewind a card), any number of writers can work concurrently over vault sync without losing updates. You get an auditable history on every card for free.

If you never connect an agent, none of this machinery is visible: the board just works like a kanban app whose data happens to be readable JSON.

## Install

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/cobbenterprises/obsidian-dev-board/releases) into `<your vault>/.obsidian/plugins/dev-board/` — or add `cobbenterprises/obsidian-dev-board` in [BRAT](https://github.com/TfTHacker/obsidian42-brat).
2. Enable **Dev Board** in Settings → Community plugins.
3. Open it from the ribbon (kanban icon), the command palette (*Open Dev Board*), or `obsidian://dev-board`.

First open writes a starter `Dev Board/board.json` with the full dev cycle and an empty board. There is no other setup. The plugin makes no network requests; everything stays in your vault.

## Configure it for your vault

All settings live in Settings → Dev Board (or the gear in any Dev Board view header):

| Setting | Default | What to consider |
| --- | --- | --- |
| Board record path | `Dev Board/board.json` | Move it if you keep app data elsewhere (e.g. `System/Dev Board/board.json`). The Events/Records/Cards folders follow the board's folder. |
| Big Board record path | `Dev Board/big_board.json` | Created on first Big Board open. |
| Meeting notes path | `Dev Board/Meeting Notes.md` | Only read if the file exists — create it when you want the recommendation journal. |
| Debriefs folder | `Dev Board/Debriefs` | Only rendered when it contains notes. |
| Project root | *(empty — whole vault)* | Folder scanned for `#project` notes offered in the card modal's project picker. |
| Your name / Agent name | `Me` / `Agent` | The labels on card chips. If your agent has a name, put it here — cards will say who created what. |
| Subsystems | *(empty)* | Comma-separated labels always offered in the subsystem picker; values already on cards appear automatically. |

**Columns are configuration too**, just not in the settings tab: edit the `columns` array in `board.json` to rename or trim the cycle. The starter set is `Recommended → Ideas → Prototype → Finalize → Build → Shipped → Reviewed → Lived → Not Sold → Rejected`. Keep the ids stable if cards already use them; the review room's route buttons adapt to whichever column a card is in.

## The workflows it enables

### 1. Capture → build → sign-off (solo, no agent)

Type into the capture bar and every idea lands as a card. Drag cards (or use ◀ ▶) through the cycle. Each card can own a Markdown note — spec, screenshots (paste them straight onto the card), decisions — created from the card's ⋯ menu or automatically at creation. When something ships, it goes to **Shipped**, and the **Review room** walks you through sign-off one card at a time: Approve → Reviewed, or send it back to Build with feedback that lands, timestamped, on the card note.

### 2. The agent files, you decide

Point your agent at [AGENTS.md](AGENTS.md) and give it one standing instruction: *file your recommendations as cards in Recommended instead of burying them in chat.* Its cards arrive with an `Agent` chip and their "why" on the face. You work the **Triage** queue (*Open Dev Board Triage*) when it suits you: Promote, Build now, Park, Not sold, or Reject — each a single click. Nothing the agent suggests interrupts you, and nothing gets lost in scrollback.

### 3. The agent builds, you review

Let the agent move its own work through `building → shipped` (it appends events; the board updates without a reload). Shipped work queues in the **Review room**: the card's origin and spec on the left, the rendered card note — build notes, screenshots, its numbered **"Your next step"** — on the right. Type feedback and hit *Needs work → Build*: the feedback lands on the card note with a timestamp, the card gets a ⟲ chip the agent checks for, and the round-trip continues until you Approve. **REVERSE** un-ships something that shouldn't have shipped, recorded as a reversal in history.

### 4. Portfolio altitude

The **Big Board** holds initiatives — the five-word ambitions implementation cards serve — in lanes you define. Link cards to an initiative (in the card modal) and each initiative shows a live *N in flight / M shipped* chip. The board filter dropdown then answers "which cards serve which initiative — and which serve none."

### 5. Session debriefs

If you (or your agent) drop a note in `Debriefs/` after a work session — frontmatter `cards:` listing what shipped — the board shows one row per session with a live "N of M to review" count and a one-click scoped review queue. This is the pattern for agent work sessions: the agent ends by writing the debrief; you review from it.

## Conventions worth adopting

- **"Your next step"** — a numbered list under that heading in any card note. The first item shows on the card face; the review room renders the whole list as a highlighted action block. It's the single clearest signal in the system for *what's waiting on a human.*
- **Decision-complete cards** — a card's `details` should let a stranger (or an agent session with no chat history) build it: what and why, concrete paths, acceptance criteria.
- **Sources are honest** — `owner` cards are your words; `agent` cards carry the agent's why. The review room shows provenance before asking you to judge, so keep them truthful.

## Troubleshooting

- **Board shows "record unreadable"** — the JSON is malformed (usually a hand-edit). Fix the syntax; the plugin never destroys the file on a failed parse.
- **A card "flickered back" after an external write** — the writer edited `board.json` directly instead of appending an event. Derived state loses; see AGENTS.md.
- **Two devices edited the same card in the same second** — the reducer breaks ties deterministically by event id; whichever ordered later wins fields, and both history entries survive.
