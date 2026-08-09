# Dev Board — external writer contract

This document is written to be handed directly to an AI agent (or read by a human building a script). It defines how to add and change cards on a Dev Board from outside Obsidian, safely, while the plugin may be running on several devices at once.

## Where things live

All paths are relative to the vault root and configurable in the plugin's settings; defaults shown:

| Path | What it is |
| --- | --- |
| `Dev Board/board.json` | Columns + the reduced card index. **Derived data — do not hand-edit cards here.** |
| `Dev Board/Events/<writer>/` | Append-only event files. **This is where you write.** |
| `Dev Board/Records/<card_id>.json` | Per-card fold of all applied events. Derived — do not edit. |
| `Dev Board/Cards/` | Per-card Markdown notes (spec, feedback, screenshots). Editable. |
| `Dev Board/Meeting Notes.md` | Optional append-only journal of recommendations. Editable (append only). |

Pick one `<writer>` directory name per writer and keep it stable — e.g. `my-agent`, `ci`, `laptop-script`. The plugin itself writes as `obsidian-desktop` / `obsidian-mobile`.

## Card shape

```json
{
  "id": "dd-20260809-ab3f",
  "title": "Add dark-mode toggle",
  "summary": "One-line summary shown on the card face",
  "details": "Implementation detail — enough context to build this without the chat it came from: what/why, files & paths, acceptance criteria, links.",
  "column": "recommended",
  "source": "agent",
  "origin": "runner",
  "project": null,
  "subsystem": "UI",
  "images": [],
  "file": null,
  "created": "2026-08-09T10:15:00",
  "updated": "2026-08-09T10:15:00",
  "history": [
    { "ts": "2026-08-09T10:15:00", "action": "created in recommended", "by": "agent" }
  ]
}
```

- `id`: `dd-YYYYMMDD-xxxx` (4 random base36 chars). Mint a fresh one; collisions are your responsibility.
- `column`: one of the ids in `board.json` `columns`. Agent recommendations belong in `recommended` — let the owner promote them.
- `source`: `"agent"` for cards you create, `"owner"` for the human's own captures. Never impersonate the owner.
- `origin`: free-form provenance label (`chat`, `runner`, `briefing`, `import`, …). Shown to the owner when they judge the card.
- `history`: append an entry for every change you make. Never rewrite or drop existing entries.
- Timestamps are **local time**, ISO seconds, no timezone suffix: `YYYY-MM-DDTHH:MM:SS`.

## Event files

One JSON file per change, written to `Dev Board/Events/<writer>/<event_id>.json`:

```json
{
  "version": 1,
  "event_id": "20260809T101500-my-agent-000001-k3j9x2q1",
  "ts": "2026-08-09T10:15:00",
  "writer": "my-agent",
  "operation": "upsert",
  "card_id": "dd-20260809-ab3f",
  "card": { "…": "the FULL card object, not a diff" }
}
```

- `event_id`: `<ts with [:+-.] stripped>-<writer>-<sequence>-<random>`. Must sort ascending in emission order for your writer: use a zero-padded sequence number, because timestamps are second-resolution and ties are broken by ordinal string comparison of `event_id`.
- `operation`: `"upsert"` (create or update) or `"archive"`.
- `card`: the complete card state after your change. Events are snapshots, not patches.
- Write the file once and never modify it. Events are immutable; the reducer deduplicates by `event_id`.

To **update** a card someone else may also be editing: read its current state from `Records/<card_id>.json` (fall back to `board.json`), apply your change, bump `updated`, append your `history` entry, and emit the full card as a new event.

## Reducer semantics (what you can rely on)

The plugin folds events into records with a commutative merge, so any application order converges:

- Events apply in `(ts, event_id)` order.
- The newest event wins scalar fields; `history` always unions (deduplicated by `ts + action + by`).
- A late-delivered **older** event can never rewind a newer card state, and an old edit can never resurrect an archived card.
- `board.json` is rewritten from records after every reduce; your event's card appears on the board without an Obsidian reload (the plugin watches for file changes).

The same contract in the other direction: treat `board.json` and `Records/` as read-only derived state. If you write `board.json` directly, a concurrent Obsidian device will overwrite you.

## Conventions the surfaces understand

- **Card notes** (`Dev Board/Cards/<id> <title>.md`): the durable record behind the card. Sections the plugin knows: `## Spec`, `# User Feedback` (dated entries the owner leaves — check for a `feedback` timestamp field on the card and address it), `## Screenshots`, and `## Your next step`.
- **"Your next step"**: a numbered list under a `## Your next step` heading. The first item renders on the card face; the full list shows in the review room. Use it whenever a card waits on the owner.
- **Meeting Notes** (optional): append recommendation lines under a `## YYYY-MM-DD` date heading, one per card you file:

  ```markdown
  - **Card title** — one-line summary `dd-20260809-ab3f`
  ```

  The board renders these with one-tap Promote actions.

## Minimal example (Node)

```js
const fs = require("fs");
const path = require("path");

function localIso(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function addCard(vault, { title, summary, details, subsystem }) {
  const ts = localIso();
  const id = `dd-${ts.slice(0, 10).replace(/-/g, "")}-${Math.random().toString(36).slice(2, 6)}`;
  const card = {
    id, title, summary: summary || "", details: details || null,
    column: "recommended", source: "agent", origin: "runner",
    project: null, subsystem: subsystem || null, images: [], file: null,
    created: ts, updated: ts,
    history: [{ ts, action: "created in recommended", by: "agent" }],
  };
  const writer = "my-agent";
  const seq = String(Date.now()).slice(-6); // per-writer monotonic is what matters
  const eventId = `${ts.replace(/[:+\-.]/g, "")}-${writer}-${seq}-${Math.random().toString(36).slice(2, 10)}`;
  const dir = path.join(vault, "Dev Board", "Events", writer);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${eventId}.json`), JSON.stringify({
    version: 1, event_id: eventId, ts, writer, operation: "upsert", card_id: id, card,
  }, null, 2) + "\n");
  return id;
}
```

## Ground rules for agents

1. File your suggestions in **Recommended** with `source: "agent"` — don't place work directly into Build columns unless the owner told you to.
2. Never edit derived state (`board.json` cards, `Records/`). Emit events.
3. Never rewrite history — yours or anyone's. Append.
4. When the owner leaves feedback (a `feedback` timestamp on the card, entries under `# User Feedback` in the note), address it, describe what you did in the note, and clear the `feedback` field in your next upsert.
5. Cards must be implementable without the conversation that created them: put the what/why, concrete paths, and acceptance criteria in `details`.
