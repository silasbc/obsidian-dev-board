// Dev Board — a kanban dev-cycle board for Obsidian, built to be shared with
// AI agents. The canonical record is a vault-backed board.json plus an
// append-only event log, so external writers (your agents or scripts) can add
// and move cards safely from outside Obsidian; this plugin is the board over
// that record. An optional Meeting Notes file is an append-only journal of
// agent recommendations, rendered at the bottom with Promote actions.

import { MarkdownRenderer, Menu, Modal, Notice, Platform, PluginSettingTab, Setting, setIcon } from "obsidian";

const ordinalCompare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
import {
  HEALTH,
  ShellPlugin,
  ShellItemView,
  computeHealth,
  guardWrite,
  localIso,
  projectIndex,
  setShellHealth,
  setStatus,
  timeAgo,
} from "./shell.js";

const VIEW_TYPE = "dev-board-view";
const REVIEW_VIEW_TYPE = "dev-board-review-view";
const BIG_VIEW_TYPE = "dev-board-big-view";
const PLUGIN_ID = "dev-board";
const DOCS_URL = "https://github.com/cobbenterprises/obsidian-dev-board";
const NOTE_ENTRY_RE = /^- \*\*(.+?)\*\*\s+—\s+(.*?)\s*`(dd-[a-z0-9-]+)`\s*$/;
const DATE_HEAD_RE = /^## (\d{4}-\d{2}-\d{2})\s*$/;

// Subsystems are free-form labels. The picker offers the configured list
// (settings) plus every value already used on a card.
function normalizeSubsystem(value) {
  const v = (value || "").trim();
  return v || null;
}

const DEFAULT_SETTINGS = {
  boardPath: "Dev Board/board.json",
  notesPath: "Dev Board/Meeting Notes.md",
  debriefsPath: "Dev Board/Debriefs",
  bigBoardPath: "Dev Board/big_board.json",
  collapseEmptyColumns: true, // [sifi] dd-20260821-2fqz: empty columns collapse to slim stubs on desktop
  projectRoot: "",
  ownerLabel: "Me",
  agentLabel: "Agent",
  subsystems: "",
};

// Starter records written on first run, so the board opens working with no
// setup. Columns follow the full dev cycle; trim or rename them in board.json.
const STARTER_BOARD = {
  version: 1,
  columns: [
    { id: "recommended", label: "Recommended" },
    { id: "ideas", label: "Ideas" },
    { id: "next", label: "Prototype" },
    { id: "finalize", label: "Finalize" },
    { id: "building", label: "Build" },
    { id: "shipped", label: "Shipped" },
    { id: "reviewed", label: "Reviewed" },
    { id: "lived", label: "Lived" },
    { id: "notsold", label: "Not Sold" },
    { id: "rejected", label: "Rejected" },
  ],
  cards: [],
  archive: [],
};

const STARTER_BIG_BOARD = {
  version: 2,
  lanes: [
    { id: "product", label: "Product" },
    { id: "platform", label: "Platform" },
    { id: "process", label: "Process" },
  ],
  columns: [
    { id: "idea", label: "Idea" },
    { id: "planned", label: "Planned" },
    { id: "inprogress", label: "In progress" },
    { id: "shipped", label: "Shipped" },
    { id: "done", label: "Done" },
  ],
  initiatives: [],
  archive: [],
};

// Big Board dd-link chips: which board.json columns count
// as "in flight" vs "shipped" for an initiative's linked implementation cards.
const BIG_IN_FLIGHT_COLUMNS = ["next", "finalize", "building"];
const BIG_SHIPPED_COLUMNS = ["shipped", "reviewed", "lived"];

// Card notes carry a numbered "Your next step" section whenever anything
// waits on the owner. Surfacing the first step on
// the card face makes the queue workable at a glance.
const NEXT_STEP_HEAD_RE = /^#{2,4}\s+Your (?:next step|sign-?off)\b.*$/im;

function parseNextSteps(body) {
  const head = body.match(NEXT_STEP_HEAD_RE);
  if (!head) return [];
  const after = body.slice(head.index + head[0].length);
  const end = after.search(/^#{1,6}\s/m);
  const section = end === -1 ? after : after.slice(0, end);
  const steps = [];
  for (const m of section.matchAll(/^\s*\d+[.)]\s+(.+)$/gm)) steps.push(m[1].trim());
  return steps;
}

// One token walk over card text: [[wikilinks]], obsidian:// + http(s) URLs,
// and bare vault `.md` paths become clickable wherever card copy renders.
const LINK_TOKEN_RE =
  /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]|\b(?:obsidian|https?):\/\/[^\s)>\]]+|(?:^|[\s`(])((?:[0-9A-Za-z][^\n`]*?\/)?[^\n`/]+\.md)(?=$|[\s`),.;])/g;

function renderLinkedText(plugin, el, text) {
  let last = 0;
  const flush = (to) => {
    if (to > last) el.appendText(text.slice(last, to));
  };
  for (const m of text.matchAll(LINK_TOKEN_RE)) {
    let start = m.index;
    let raw = m[0];
    let label = raw;
    let onClick = null;
    if (m[1]) {
      const target = m[1].trim();
      label = (m[2] || m[1]).trim();
      onClick = () => plugin.app.workspace.openLinkText(target, "", false);
    } else if (m[3]) {
      start += raw.indexOf(m[3]);
      raw = m[3];
      label = m[3];
      const dest = plugin.app.metadataCache.getFirstLinkpathDest(m[3].replace(/\.md$/, ""), "");
      if (dest) onClick = () => plugin.app.workspace.getLeaf(false).openFile(dest);
    } else {
      const url = raw;
      onClick = () => window.open(url);
    }
    if (!onClick) continue; // unresolved .md path stays plain text
    flush(start);
    const link = el.createEl("a", { cls: "sdd-textlink", text: label, attr: { title: raw } });
    link.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    last = start + raw.length;
  }
  flush(text.length);
}

function collectUrls(text) {
  return [...text.matchAll(/\b(?:obsidian|https?):\/\/[^\s)>\]]+/g)].map((m) => m[0]);
}

/** Full-screen lightbox for card screenshots: click any
 *  image in the review room or card modal to see it at real size. */
function openImageLightbox(src, alt) {
  const overlay = document.body.createDiv({ cls: "sdd-lightbox" });
  overlay.createEl("img", { attr: { src, alt: alt || "" } });
  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  overlay.addEventListener("click", close);
  document.addEventListener("keydown", onKey, true);
}

/** Make images and internal links inside a rendered/attached container work:
 *  imgs open the lightbox, a.internal-link opens the note (MarkdownRenderer
 *  output doesn't navigate on its own inside a custom view  ). */
// "Your next step" sections render as a highlighted action block instead of a
// plain heading + list, so the action items stand out. Wraps the heading and everything up to the next
// same-or-higher heading into .sdd-nextsteps.
function decorateNextSteps(containerEl) {
  const headings = Array.from(containerEl.querySelectorAll("h1, h2, h3"));
  for (const h of headings) {
    if (!/^\s*your next step/i.test(h.textContent || "")) continue;
    const level = Number(h.tagName[1]);
    const block = document.createElement("div");
    block.className = "sdd-nextsteps";
    const top = h.closest(".markdown-rendered > *") || h;
    top.before(block);
    const banner = block.createDiv({ cls: "sdd-nextsteps__banner" });
    banner.createSpan({ cls: "sdd-nextsteps__icon", text: "→" });
    banner.createSpan({ cls: "sdd-nextsteps__label", text: h.textContent });
    const bodyEl = block.createDiv({ cls: "sdd-nextsteps__body" });
    let node = top.nextSibling;
    top.remove(); // original heading replaced by the banner
    while (node) {
      const next = node.nextSibling;
      const el = node instanceof HTMLElement ? node : null;
      const tag = el ? el.tagName : "";
      const isHeading = /^H[1-6]$/.test(tag);
      const innerHeading = el && !isHeading ? el.querySelector("h1,h2,h3,h4,h5,h6") : null;
      if ((isHeading && Number(tag[1]) <= level) ||
          (innerHeading && Number(innerHeading.tagName[1]) <= level)) break;
      bodyEl.appendChild(node);
      node = next;
    }
  }
}

function wireRenderedContent(plugin, containerEl, sourcePath) {
  containerEl.addEventListener("click", (e) => {
    const img = e.target.closest("img");
    if (img && containerEl.contains(img)) {
      e.preventDefault();
      e.stopPropagation();
      openImageLightbox(img.getAttribute("src"), img.getAttribute("alt"));
      return;
    }
    const a = e.target.closest("a.internal-link");
    if (a) {
      e.preventDefault();
      e.stopPropagation();
      const target = a.getAttribute("data-href") || a.getAttribute("href");
      if (target) plugin.app.workspace.openLinkText(target, sourcePath || "", false);
    }
  });
}

export default class DevBoardPlugin extends ShellPlugin {
  scaffold() {
    return {
      viewType: VIEW_TYPE,
      view: (leaf) => new DevBoardView(leaf, this),
      ribbon: { icon: "square-kanban", label: "Dev Board" },
      command: { id: "open-dev-board", name: "Open Dev Board" },
      protocol: "dev-board",
      settingsTab: () => new DevBoardSettingTab(this.app, this),
      defaults: DEFAULT_SETTINGS,
    };
  }

  async initState() {
    this.board = null;
    this.bigBoard = null;
    this.noteEntries = [];
    this.debriefs = [];
    this.lastError = null;
    this.bigError = null;
    this._saving = false;
    this._nextStepCache = new Map(); // card file path → { mtime, steps }
  }

  /** Numbered "Your next step" items from the card note, cached per mtime. */
  async nextStepsFor(card) {
    if (!card.file) return [];
    const file = this.app.vault.getAbstractFileByPath(card.file);
    if (!file || !file.stat) return [];
    const cached = this._nextStepCache.get(card.file);
    if (cached && cached.mtime === file.stat.mtime) return cached.steps;
    let steps = [];
    try {
      steps = parseNextSteps(await this.app.vault.cachedRead(file));
    } catch (e) {
      /* unreadable note = no chip */
    }
    this._nextStepCache.set(card.file, { mtime: file.stat.mtime, steps });
    return steps;
  }

  async afterLoad() {
    // Second surface: the Review room — click-through sign-off over Shipped.
    this.registerView(REVIEW_VIEW_TYPE, (leaf) => new ReviewView(leaf, this));
    this.addCommand({
      id: "open-dev-board-review",
      name: "Open Dev Board Review",
      callback: () => this.activateReviewView(),
    });
    this.registerObsidianProtocolHandler("dev-board-review", (params) =>
      this.activateReviewView(
        params.cards ? String(params.cards).split(",").filter(Boolean) : undefined
      )
    );
    // Third surface: the Triage room — same click-through, over Recommended/Ideas.
    this.addCommand({
      id: "open-dev-board-triage",
      name: "Open Dev Board Triage",
      callback: () => this.activateReviewView(undefined, "triage"),
    });
    this.registerObsidianProtocolHandler("dev-board-triage", () =>
      this.activateReviewView(undefined, "triage")
    );
    // Fourth surface: the Big Board — higher-altitude portfolio kanban
    //: big initiatives in theme lanes, complementing (never
    // replacing) the implementation-card board below it.
    this.registerView(BIG_VIEW_TYPE, (leaf) => new BigBoardView(leaf, this));
    this.addCommand({
      id: "open-dev-board-big",
      name: "Open Big Board",
      callback: () => this.activateBigBoardView(),
    });
    this.registerObsidianProtocolHandler("dev-board-big", () =>
      this.activateBigBoardView()
    );

    // External writers (agents, scripts) edit the record directly — refresh
    // open boards when the files change under us.
    this.registerEvent(
      this.app.vault.on("modify", (f) => {
        if (this._saving) return;
        if (
          f.path === this.settings.boardPath ||
          f.path === this.settings.notesPath ||
          f.path === this.settings.bigBoardPath ||
          f.path.startsWith(this.settings.debriefsPath + "/")
        ) {
          this.refreshOpenViews();
        }
      })
    );
  }

  async activateBigBoardView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(BIG_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf(true);
      await leaf.setViewState({ type: BIG_VIEW_TYPE, active: true });
    } else if (typeof leaf.view.refresh === "function") {
      await leaf.view.refresh();
    }
    workspace.revealLeaf(leaf);
  }

  async loadBigBoard() {
    try {
      if (!(await this.app.vault.adapter.exists(this.settings.bigBoardPath))) {
        // [sifi] dd-20260831-btsp: big_board.json is not event-sourced, so a blank
        // scaffold written here would overwrite the real one when sync catches up.
        if (this.syncPending) {
          throw new Error("big_board.json has not synced to this device yet — waiting rather than writing a blank one over it");
        }
        await this.ensureRecordDir(this.settings.bigBoardPath.split("/").slice(0, -1).join("/"));
        await this.atomicWrite(this.settings.bigBoardPath, JSON.stringify(STARTER_BIG_BOARD, null, 2) + "\n");
      }
      const raw = await this.app.vault.adapter.read(this.settings.bigBoardPath);
      const board = JSON.parse(raw);
      let migrated = false;
      if (Array.isArray(board.bets)) {
        const current = Array.isArray(board.initiatives) ? board.initiatives : [];
        const ids = new Set(current.map((initiative) => initiative.id));
        board.initiatives = [
          ...current,
          ...board.bets.filter((initiative) => !ids.has(initiative.id)),
        ];
        delete board.bets;
        migrated = true;
      } else if (!Array.isArray(board.initiatives)) {
        board.initiatives = [];
        migrated = true;
      }
      if ((Number(board.version) || 0) < 2) {
        board.version = 2;
        migrated = true;
      }
      this.bigBoard = board;
      this.bigError = null;
      if (migrated) await this.saveBigBoard();
    } catch (e) {
      this.bigBoard = null;
      this.bigError = `Cannot read ${this.settings.bigBoardPath}: ${e.message || e}`;
    }
  }

  async saveBigBoard() {
    if (!this.bigBoard) return;
    this._saving = true;
    try {
      await guardWrite("Saving Big Board", () =>
        this.app.vault.adapter.write(
          this.settings.bigBoardPath,
          JSON.stringify(this.bigBoard, null, 2) + "\n"
        )
      );
    } finally {
      window.setTimeout(() => (this._saving = false), 500);
    }
  }

  bigLanes() {
    return this.bigBoard?.lanes || [];
  }

  bigColumns() {
    return this.bigBoard?.columns || [];
  }

  newInitiativeId() {
    const stamp = localIso().slice(0, 10).replace(/-/g, "");
    const existing = new Set([
      ...(this.bigBoard?.initiatives || []).map((b) => b.id),
      ...(this.bigBoard?.archive || []).map((b) => b.id),
    ]);
    for (;;) {
      const suffix = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
      const id = `bb-${stamp}-${suffix}`;
      if (!existing.has(id)) return id;
    }
  }

  async addInitiative({ title, why, lane, column, dd }) {
    if (!this.bigBoard || !title) return null;
    const initiative = {
      id: this.newInitiativeId(),
      title,
      why: why || "",
      lane: lane || this.bigLanes()[0]?.id || "platform",
      column: column || "idea",
      dd: Array.isArray(dd) ? dd : [],
      created: localIso(),
      updated: localIso(),
      history: [{ ts: localIso(), action: "created", by: "owner" }],
    };
    this.bigBoard.initiatives = this.bigBoard.initiatives || [];
    this.bigBoard.initiatives.unshift(initiative);
    await this.saveBigBoard();
    return initiative;
  }

  async moveInitiative(id, lane, column) {
    const initiative = (this.bigBoard?.initiatives || []).find((b) => b.id === id);
    if (!initiative || (initiative.lane === lane && initiative.column === column)) return;
    const from = `${initiative.lane}/${initiative.column}`;
    initiative.lane = lane;
    initiative.column = column;
    initiative.updated = localIso();
    (initiative.history = initiative.history || []).push({
      ts: localIso(),
      action: `moved ${from} → ${lane}/${column}`,
      by: "owner",
    });
    await this.saveBigBoard();
  }

  async archiveInitiative(id) {
    const initiatives = this.bigBoard?.initiatives || [];
    const idx = initiatives.findIndex((b) => b.id === id);
    if (idx === -1) return;
    const [initiative] = initiatives.splice(idx, 1);
    (initiative.history = initiative.history || []).push({ ts: localIso(), action: "archived", by: "owner" });
    (this.bigBoard.archive = this.bigBoard.archive || []).push(initiative);
    await this.saveBigBoard();
  }

  /** The initiative currently linking a dd- card, if any (one initiative per card). */
  initiativeForCard(cardId) {
    return (this.bigBoard?.initiatives || []).find((b) => (b.dd || []).includes(cardId)) || null;
  }

  /** Attach a dd- card to an initiative — or detach with initiativeId=null. Keeps a card on
   *  at most one initiative: linking removes it from any other initiative's dd list. */
  async linkCardToInitiative(cardId, initiativeId) {
    if (!this.bigBoard || !cardId) return;
    let changed = false;
    for (const initiative of this.bigBoard.initiatives || []) {
      const dd = initiative.dd || [];
      if (initiative.id === initiativeId) {
        if (!dd.includes(cardId)) {
          initiative.dd = [...dd, cardId];
          initiative.updated = localIso();
          (initiative.history = initiative.history || []).push({ ts: localIso(), action: `linked ${cardId}`, by: "owner" });
          changed = true;
        }
      } else if (dd.includes(cardId)) {
        initiative.dd = dd.filter((x) => x !== cardId);
        initiative.updated = localIso();
        (initiative.history = initiative.history || []).push({ ts: localIso(), action: `unlinked ${cardId}`, by: "owner" });
        changed = true;
      }
    }
    if (changed) await this.saveBigBoard();
  }

  /** Live "N in flight / M shipped" over an initiative's linked dd- cards. */
  initiativeStats(initiative) {
    const cards = this.board?.cards || [];
    const linked = new Set(initiative.dd || []);
    if (!linked.size) return null;
    let inFlight = 0;
    let shipped = 0;
    for (const c of cards) {
      if (!linked.has(c.id)) continue;
      if (BIG_IN_FLIGHT_COLUMNS.includes(c.column)) inFlight += 1;
      else if (BIG_SHIPPED_COLUMNS.includes(c.column)) shipped += 1;
    }
    return { inFlight, shipped, linked: linked.size };
  }

  // [sifi] What the Dev Board folder already holds, for the bootstrap guard below.
  async boardHistory() {
    const adapter = this.app.vault.adapter;
    const root = this.boardDir();
    const count = async (dir, re) => {
      try {
        const listing = await adapter.list(dir);
        let n = (listing.files || []).filter((f) => re.test(f)).length;
        for (const sub of listing.folders || []) {
          try {
            const inner = await adapter.list(sub);
            n += (inner.files || []).filter((f) => re.test(f)).length;
          } catch (e) { /* unreadable subfolder */ }
        }
        return n;
      } catch (e) {
        return 0;
      }
    };
    return {
      events: await count(`${root}/Events`, /\.json$/),
      records: await count(`${root}/Records`, /\.json$/),
      cards: await count(`${root}/Cards`, /\.md$/),
    };
  }

  async loadBoard() {
    try {
      // First run: write a starter board so the plugin opens working — but only
      // on a truly empty board. [sifi] dd-20260831-btsp: a device whose
      // board.json has not synced yet (Obsidian Sync skips .json by default)
      // still holds Events/, Records/, or card notes; scaffolding a blank
      // starter there blanked the board on two devices on 2026-08-31. With
      // history present, only a columns shell is written and the reducer
      // rebuilds every card from the event log; with card notes but no
      // history, the board says so instead of pretending to be empty.
      this.bootstrapWarning = null;
      this.syncPending = false;
      if (!(await this.app.vault.adapter.exists(this.settings.boardPath))) {
        const history = await this.boardHistory();
        await this.ensureRecordDir(this.boardDir());
        await this.atomicWrite(this.settings.boardPath, JSON.stringify(STARTER_BOARD, null, 2) + "\n");
        if (history.events || history.records) {
          this.syncPending = true;
          this.bootstrapWarning = `board.json was missing on this device; rebuilt from ${history.events} event file(s) and ${history.records} record(s).`;
        } else if (history.cards) {
          this.syncPending = true;
          this.bootstrapWarning = `${history.cards} card note(s) are here but no board events or records have synced yet, so this board shows empty until they arrive. Enable "Sync all other types" for this vault on the device that holds the board, then on this one.`;
        }
      }
      await this.reduceBoardEvents();
      const raw = await this.app.vault.adapter.read(this.settings.boardPath);
      this.board = JSON.parse(raw);
      this._recordSnapshot = new Map(
        [...(this.board.cards || []), ...(this.board.archive || [])]
          .map((card) => [card.id, JSON.stringify(card)])
      );
      this.lastError = null;
    } catch (e) {
      this.board = null;
      this.lastError = `Cannot read ${this.settings.boardPath}: ${e.message || e}`;
    }
    this.noteEntries = [];
    try {
      const text = await this.app.vault.adapter.read(this.settings.notesPath);
      let date = null;
      for (const line of text.split("\n")) {
        const d = line.match(DATE_HEAD_RE);
        if (d) { date = d[1]; continue; }
        const m = line.match(NOTE_ENTRY_RE);
        if (m) this.noteEntries.push({ date, title: m[1], summary: m[2], id: m[3] });
      }
    } catch (e) {
      /* meeting notes optional; health reports it */
      this._notesError = `${e.message || e}`;
    }
    // Session debriefs: one file per work session in Debriefs/, frontmatter
    // dd_debrief (date) + cards (ids shipped that session). Newest first.
    this.debriefs = [];
    const prefix = this.settings.debriefsPath + "/";
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (!f.path.startsWith(prefix)) continue;
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter || {};
      const cards = Array.isArray(fm.cards) ? fm.cards.map(String) : [];
      this.debriefs.push({
        file: f,
        date: fm.dd_debrief ? String(fm.dd_debrief) : f.basename.slice(0, 10),
        title: f.basename,
        cards,
      });
    }
    this.debriefs.sort((a, b) => b.title.localeCompare(a.title));
  }

  /** Open (or focus) the Review room; cardIds scopes the queue (e.g. one
   *  debrief); mode "triage" flips it to the Recommended/Ideas backlog
   *. */
  async activateReviewView(cardIds, mode = "shipped") {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(REVIEW_VIEW_TYPE)[0];
    if (!leaf) {
      this._pendingReviewIds = cardIds || null;
      this._pendingReviewMode = mode;
      leaf = workspace.getLeaf(true);
      await leaf.setViewState({ type: REVIEW_VIEW_TYPE, active: true });
    } else {
      const v = leaf.view;
      if (cardIds) {
        v.queueIds = cardIds;
        v.index = 0;
      }
      if (v.mode !== mode) {
        v.mode = mode;
        v.index = 0;
      }
      if (typeof v.refresh === "function") await v.refresh();
    }
    workspace.revealLeaf(leaf);
  }

  async refreshOpenViews() {
    await super.refreshOpenViews();
    for (const type of [REVIEW_VIEW_TYPE, BIG_VIEW_TYPE]) {
      for (const leaf of this.app.workspace.getLeavesOfType(type)) {
        if (typeof leaf.view.refresh === "function") await leaf.view.refresh();
      }
    }
  }

  async ensureRecordDir(path) {
    const adapter = this.app.vault.adapter;
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
    }
  }

  eventClock(event) {
    return [String(event.ts || ""), String(event.event_id || "")];
  }

  mergeCardRecord(existing, incoming, event) {
    // Mirrors dd_store.py merge_card exactly: the fold is COMMUTATIVE — fields
    // and the clock advance only for events newer than the newest known event
    // (a late iCloud delivery must never rewind the clock), history always
    // unions, and ordering is ordinal so both reducers converge byte-identically.
    const clock = this.eventClock(event);
    const currentClock = existing?._clock || ["", ""];
    const result = existing ? { ...existing } : { ...incoming };
    const wins = !existing || ordinalCompare(clock.join("\u0000"), currentClock.join("\u0000")) >= 0;
    if (wins) {
      for (const [key, value] of Object.entries(incoming || {})) {
        if (key !== "history") result[key] = value;
      }
      result._clock = clock;
    } else {
      result._clock = currentClock;
    }
    const seen = new Set();
    result.history = [...(existing?.history || []), ...(incoming?.history || [])]
      .sort((a, b) => ordinalCompare(`${a.ts || ""}\u0000${a.action || ""}\u0000${a.by || ""}`, `${b.ts || ""}\u0000${b.action || ""}\u0000${b.by || ""}`))
      .filter((row) => {
        const key = `${row.ts || ""}\u0000${row.action || ""}\u0000${row.by || ""}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    return result;
  }

  async atomicWrite(path, text) {
    // temp + rename where the adapter supports it; plain write as last resort.
    const adapter = this.app.vault.adapter;
    const tmp = `${path}.tmp-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await adapter.write(tmp, text);
      try {
        await adapter.rename(tmp, path);
      } catch (renameError) {
        if (await adapter.exists(path)) await adapter.remove(path);
        await adapter.rename(tmp, path);
      }
    } catch (writeError) {
      try { if (await adapter.exists(tmp)) await adapter.remove(tmp); } catch (cleanupError) { /* best effort */ }
      await adapter.write(path, text);
    }
  }

  async reduceBoardEvents() {
    const adapter = this.app.vault.adapter;
    const root = this.boardDir();
    const eventsRoot = `${root}/Events`;
    const recordsRoot = `${root}/Records`;
    await this.ensureRecordDir(eventsRoot);
    await this.ensureRecordDir(recordsRoot);
    const eventFiles = [];
    try {
      const top = await adapter.list(eventsRoot);
      for (const folder of top.folders || []) {
        const listing = await adapter.list(folder);
        eventFiles.push(...(listing.files || []).filter((path) => path.endsWith(".json")));
      }
    } catch (e) { /* no events yet */ }
    // Apply in (ts, event_id) order — matching dd_store.py — not file-path
    // order, where the writer-directory name dominated the timestamp.
    const events = [];
    for (const path of eventFiles) {
      try {
        const event = JSON.parse(await adapter.read(path));
        if (event.event_id && event.card_id && event.card) events.push(event);
      } catch (e) { /* unreadable event skipped; doctor surfaces it */ }
    }
    events.sort((a, b) => ordinalCompare(this.eventClock(a).join("\u0000"), this.eventClock(b).join("\u0000")));
    let applied = 0;
    const openRecords = new Map();
    for (const event of events) {
      const recordPath = `${recordsRoot}/${event.card_id}.json`;
      let record = openRecords.get(event.card_id);
      if (!record) {
        record = { version: 1, card_id: event.card_id, card: null, archived: false, applied_events: [], clock: ["", ""] };
        try { record = { ...record, ...JSON.parse(await adapter.read(recordPath)) }; } catch (e) { /* new */ }
      }
      openRecords.set(event.card_id, record);
      if ((record.applied_events || []).includes(event.event_id)) continue;
      record.card = this.mergeCardRecord(record.card, event.card, event);
      // archived/clock derive from the WINNING event, not the last applied —
      // a late older edit must not resurrect an archived card.
      const incomingClock = this.eventClock(event);
      if (ordinalCompare(incomingClock.join("\u0000"), (record.clock || ["", ""]).join("\u0000")) >= 0) {
        record.archived = event.operation === "archive";
        record.clock = incomingClock;
      }
      record.applied_events = [...new Set([...(record.applied_events || []), event.event_id])].sort();
      record._dirty = true;
      applied++;
    }
    for (const [cardId, record] of openRecords) {
      if (!record._dirty) continue;
      delete record._dirty;
      await this.atomicWrite(`${recordsRoot}/${cardId}.json`, JSON.stringify(record, null, 2) + "\n");
    }
    const records = [];
    try {
      const listing = await adapter.list(recordsRoot);
      for (const path of (listing.files || []).filter((item) => /\/dd-[^/]+\.json$/.test(item)).sort()) {
        try { records.push(JSON.parse(await adapter.read(path))); } catch (e) { /* malformed record stays visible in doctor */ }
      }
    } catch (e) { return; }
    if (!records.length) return;
    let shell = { version: 1, columns: [] };
    try {
      const current = JSON.parse(await adapter.read(this.settings.boardPath));
      shell = { version: current.version || 1, columns: current.columns || [] };
    } catch (e) {
      // Column config lives ONLY in board.json: if the file exists but is
      // momentarily unreadable, abort rather than write a columns-less shell.
      if (await adapter.exists(this.settings.boardPath)) {
        console.error("Dev Board: board.json unreadable; skipping index rewrite to protect columns", e);
        return;
      }
    }
    const active = [], archive = [];
    for (const record of records) {
      const card = { ...(record.card || {}) };
      delete card._clock;
      if (!card.id) continue;
      (record.archived ? archive : active).push(card);
    }
    const sorter = (a, b) => ordinalCompare(`${b.updated || ""}\u0000${b.id}`, `${a.updated || ""}\u0000${a.id}`);
    active.sort(sorter); archive.sort(sorter);
    const nextBoard = JSON.stringify({ ...shell, cards: active, archive }, null, 2) + "\n";
    let currentBoard = null;
    try { currentBoard = await adapter.read(this.settings.boardPath); } catch (e) { /* first write */ }
    if (nextBoard !== currentBoard) {
      this._saving = true;
      await this.atomicWrite(this.settings.boardPath, nextBoard);
    }
    this.pendingEventCount = applied;
  }

  async emitBoardEvents() {
    const root = this.boardDir();
    const writer = `obsidian-${Platform.isMobile ? "mobile" : "desktop"}`;
    const eventDir = `${root}/Events/${writer}`;
    await this.ensureRecordDir(eventDir);
    const snapshot = this._recordSnapshot || new Map();
    for (const [archived, cards] of [[false, this.board.cards || []], [true, this.board.archive || []]]) {
      for (const card of cards) {
        const serialized = JSON.stringify(card);
        if (snapshot.get(card.id) === serialized) continue;
        const ts = localIso();
        // Timestamps are second-resolution, so two writes in the same second
        // tie on ts and fall to the event-id string for ordering. A monotonic
        // per-session sequence keeps same-writer events applying in emission
        // order; the random suffix keeps ids unique across restarts.
        const seq = String((this._eventSeq = (this._eventSeq || 0) + 1)).padStart(6, "0");
        const nonce = Math.random().toString(36).slice(2, 10);
        const eventId = `${ts.replace(/[:+\-.]/g, "")}-${writer}-${seq}-${nonce}`;
        const event = { version: 1, event_id: eventId, ts, writer, operation: archived ? "archive" : "upsert", card_id: card.id, card };
        await this.app.vault.adapter.write(`${eventDir}/${eventId}.json`, JSON.stringify(event, null, 2) + "\n");
      }
    }
  }

  async saveBoard() {
    if (!this.board) return;
    this._saving = true;
    try {
      await guardWrite("Saving conflict-safe board records", async () => {
        await this.emitBoardEvents();
        await this.reduceBoardEvents();
        const raw = await this.app.vault.adapter.read(this.settings.boardPath);
        this.board = JSON.parse(raw);
        this._recordSnapshot = new Map(
          [...(this.board.cards || []), ...(this.board.archive || [])]
            .map((card) => [card.id, JSON.stringify(card)])
        );
      });
    } finally {
      // let the modify event from our own write drain before re-listening
      window.setTimeout(() => (this._saving = false), 500);
    }
  }

  columns() {
    return this.board?.columns || [];
  }

  columnLabel(id) {
    return this.columns().find((c) => c.id === id)?.label || id;
  }

  findCard(id) {
    return (this.board?.cards || []).find((c) => c.id === id) || null;
  }

  newCardId() {
    const date = new Date();
    const ymd =
      date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
    const taken = new Set(
      [...(this.board?.cards || []), ...(this.board?.archive || [])].map((c) => c.id)
    );
    for (;;) {
      const suffix = Math.random().toString(36).slice(2, 6);
      const id = `dd-${ymd}-${suffix}`;
      if (!taken.has(id)) return id;
    }
  }

  async addCard({ id, title, summary = "", details = null, column = "ideas", source = "owner", origin = "board", project = null, subsystem = null, images = [], file = null }) {
    if (!this.board) return null;
    const ts = localIso();
    const card = {
      id: id || this.newCardId(),
      title: title.trim(),
      summary,
      details,
      column,
      source,
      origin,
      project,
      subsystem: normalizeSubsystem(subsystem),
      images,
      file,
      created: ts,
      updated: ts,
      history: [{ ts, action: `created in ${column}`, by: source }],
    };
    this.board.cards.unshift(card);
    await this.saveBoard();
    // Every card owns its note from birth: scaffold the card note at creation
    // so the full record (spec, feedback, build, testing) has one home from
    // day one.
    if (!card.file) {
      try {
        await this.ensureCardFile(card, { log: false });
      } catch (e) {
        // Note creation failing should never block the card itself.
      }
    }
    return card;
  }

  async moveCard(id, toColumn, by = "owner") {
    const card = this.findCard(id);
    if (!card || card.column === toColumn) return;
    const from = card.column;
    card.column = toColumn;
    card.updated = localIso();
    (card.history = card.history || []).push({
      ts: card.updated,
      action: `moved ${from} → ${toColumn}`,
      by,
    });
    await this.saveBoard();
  }

  async updateCard(id, fields, by = "owner") {
    const card = this.findCard(id);
    if (!card) return;
    const moved = fields.column && fields.column !== card.column ? card.column : null;
    Object.assign(card, fields);
    card.updated = localIso();
    (card.history = card.history || []).push({
      ts: card.updated,
      action: moved ? `edited; moved ${moved} → ${card.column}` : "edited",
      by,
    });
    await this.saveBoard();
  }

  boardDir() {
    return this.settings.boardPath.split("/").slice(0, -1).join("/");
  }

  /**
   * Every card can own a markdown note in <board dir>/Cards/ — the durable,
   * editable record behind the modal (screenshots embed there as normal vault
   * attachments). Creates the note and stamps card.file when missing.
   */
  /** The card note is the full record: before the review
   *  room renders or opens a note, make sure the board-side spec (summary +
   *  details) lives on it too — older notes were created without it.
   *  Idempotent: skips when a Spec section exists or the card has nothing
   *  beyond its title to add. */
  async ensureSpecOnNote(card) {
    if (!card.file) return;
    const f = this.app.vault.getAbstractFileByPath(card.file);
    if (!f) return;
    let text;
    try {
      text = await this.app.vault.read(f);
    } catch (e) {
      return;
    }
    if (/^##\s+Spec\b/m.test(text)) return;
    const parts = [];
    if (card.summary?.trim()) parts.push(card.summary.trim());
    if (card.details?.trim()) parts.push(card.details.trim());
    if (!parts.length) return;
    const spec = `\n\n## Spec (from the board card)\n\n${parts.join("\n\n")}\n`;
    await this.app.vault.modify(f, text.replace(/\s*$/, "") + spec);
  }

  async ensureCardFile(card, { log = true } = {}) {
    if (card.file && this.app.vault.getAbstractFileByPath(card.file)) return card.file;
    const dir = `${this.boardDir()}/Cards`;
    if (!this.app.vault.getAbstractFileByPath(dir)) {
      await this.app.vault.createFolder(dir).catch(() => {});
    }
    const slug = card.title.replace(/[\\/:*?"<>|#[\]]/g, "").trim().slice(0, 60) || "card";
    let path = `${dir}/${card.id} ${slug}.md`;
    let n = 1;
    while (this.app.vault.getAbstractFileByPath(path)) {
      n += 1;
      path = `${dir}/${card.id} ${slug} ${n}.md`;
    }
    const body = [
      "---",
      `dd_id: ${card.id}`,
      `created: ${localIso()}`,
      "---",
      "",
      `# ${card.title}`,
      "",
      card.summary ? `${card.summary}\n` : "",
      card.details ? `## Spec\n\n${card.details}\n` : "",
      "## Notes",
      "",
      "## Screenshots",
      "",
    ].filter((l) => l !== "").join("\n");
    await guardWrite("Creating the card note", () => this.app.vault.create(path, body));
    const live = this.findCard(card.id);
    if (live) {
      live.file = path;
      live.updated = localIso();
      if (log) {
        (live.history = live.history || []).push({ ts: live.updated, action: "card note created", by: "owner" });
      }
      await this.saveBoard();
    }
    card.file = path;
    return path;
  }

  /**
   * Append a timestamped feedback entry to the card note's User Feedback
   * section (created at the top when missing) and flag the card so agents see
   * a ⟲ feedback chip. Agents clear card.feedback once they've addressed it.
   */
  async recordCardFeedback(card, text, action = "feedback recorded") {
    await this.writeFeedbackEntry(card, text);
    const live = this.findCard(card.id);
    if (live) {
      live.feedback = localIso();
      live.updated = live.feedback;
      (live.history = live.history || []).push({ ts: live.updated, action, by: "owner" });
      await this.saveBoard();
    }
  }

  /** Append a dated feedback entry to the card note (no board write). */
  async writeFeedbackEntry(card, text) {
    const path = await this.ensureCardFile(card);
    const file = this.app.vault.getAbstractFileByPath(path);
    const entry = `**${this.settings.ownerLabel} — ${localIso().replace("T", " ")}:**\n${text.trim()}\n`;
    await guardWrite("Recording feedback", () =>
      this.app.vault.process(file, (body) => {
        const heading = "# User Feedback";
        const at = body.indexOf(heading);
        if (at !== -1) {
          const insertAt = at + heading.length;
          return `${body.slice(0, insertAt)}\n\n${entry}${body.slice(insertAt)}`;
        }
        const fmEnd = body.startsWith("---") ? body.indexOf("\n---", 3) : -1;
        if (fmEnd !== -1) {
          const cut = fmEnd + "\n---".length + 1;
          return `${body.slice(0, cut)}\n${heading}\n\n${entry}\n${body.slice(cut)}`;
        }
        return `${heading}\n\n${entry}\n${body}`;
      })
    );
  }

  /** Feedback + column move as ONE board mutation → one event. Two separate
   *  writes landed two same-second events whose tie the reducer could break
   *  the wrong way — the card visibly stayed put, so Needs work got clicked
   *  again and again, duplicating feedback. */
  async feedbackAndMove(card, text, toColumn, by = "owner") {
    if (text) await this.writeFeedbackEntry(card, text);
    const live = this.findCard(card.id);
    if (!live) return;
    const ts = localIso();
    live.history = live.history || [];
    if (text) {
      live.feedback = ts;
      live.history.push({ ts, action: "feedback recorded", by });
    }
    if (toColumn && live.column !== toColumn) {
      live.history.push({ ts, action: `moved ${live.column} → ${toColumn}`, by });
      live.column = toColumn;
    }
    live.updated = ts;
    await this.saveBoard();
  }

  /** REVERSE a built card: back to the Build column with a
   *  reversal history entry — the trail reads "reverted", not just a move.
   *  One implementation for the card modal and the review room. */
  async reverseToBuild(cardId, by = "owner") {
    const live = this.findCard(cardId);
    if (!live) return;
    const ts = localIso();
    (live.history = live.history || []).push({
      ts, action: `reversal — reverted ${live.column} → building`, by,
    });
    live.column = "building";
    live.updated = ts;
    await this.saveBoard();
  }

  /** Append pasted-screenshot embeds into the card note's Screenshots section. */
  async appendImagesToCardFile(path, imagePaths) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file || !imagePaths.length) return;
    const embeds = imagePaths.map((p) => `![[${p}]]`).join("\n");
    await guardWrite("Adding screenshots to the card note", () =>
      this.app.vault.process(file, (text) => {
        const marker = "## Screenshots";
        const at = text.indexOf(marker);
        if (at === -1) return `${text.trimEnd()}\n\n${marker}\n\n${embeds}\n`;
        const insertAt = at + marker.length;
        return `${text.slice(0, insertAt)}\n\n${embeds}${text.slice(insertAt)}`;
      })
    );
  }

  /** Write a pasted screenshot into the board's Attachments folder; returns the vault path. */
  async saveCardImage(cardId, buffer, index) {
    const dir = `${this.settings.boardPath.split("/").slice(0, -1).join("/")}/Attachments`;
    if (!this.app.vault.getAbstractFileByPath(dir)) {
      await this.app.vault.createFolder(dir).catch(() => {});
    }
    const stamp = localIso().replace(/[:T]/g, "").slice(0, 14);
    let path = `${dir}/${cardId} ${stamp}-${index}.png`;
    let n = index;
    while (this.app.vault.getAbstractFileByPath(path)) {
      n += 1;
      path = `${dir}/${cardId} ${stamp}-${n}.png`;
    }
    await this.app.vault.createBinary(path, buffer);
    return path;
  }

  async archiveCard(id, by = "owner") {
    if (!this.board) return;
    const idx = (this.board.cards || []).findIndex((c) => c.id === id);
    if (idx === -1) return;
    const [card] = this.board.cards.splice(idx, 1);
    card.updated = localIso();
    (card.history = card.history || []).push({ ts: card.updated, action: "archived", by });
    (this.board.archive = this.board.archive || []).unshift(card);
    await this.saveBoard();
  }

  /** Promote a meeting-notes entry: move its card, or recreate it if missing. */
  async promoteEntry(entry, toColumn) {
    const existing = this.findCard(entry.id);
    if (existing) {
      await this.moveCard(entry.id, toColumn);
      return existing;
    }
    return this.addCard({
      id: entry.id,
      title: entry.title,
      summary: entry.summary,
      column: toColumn,
      source: "agent",
      origin: "meeting-notes",
    });
  }

  boardHealth() {
    const checks = [];
    if (this.lastError) {
      checks.push({ state: HEALTH.BROKEN, reason: this.lastError });
      return computeHealth(checks);
    }
    const cards = this.board?.cards || [];
    const rec = cards.filter((c) => c.column === "recommended").length;
    checks.push({
      state: HEALTH.HEALTHY,
      reason: `${cards.length} cards · ${rec} recommended`,
    });
    return computeHealth(checks);
  }

  subsystemValues() {
    const vals = new Set(
      String(this.settings.subsystems || "")
        .split(",").map((s) => s.trim()).filter(Boolean)
    );
    for (const c of [...(this.board?.cards || []), ...(this.board?.archive || [])]) {
      if (c.subsystem) vals.add(normalizeSubsystem(c.subsystem));
    }
    return [...vals].sort();
  }

  openInDefaultApp(vaultRelPath) {
    if (Platform.isMobile) {
      new Notice("Open this file from a desktop client: " + vaultRelPath);
      return;
    }
    this.app.openWithDefaultApp(vaultRelPath);
  }
}

class DevBoardView extends ShellItemView {
  constructor(leaf, plugin) {
    super(leaf, {
      viewType: VIEW_TYPE,
      title: "Dev Board",
      icon: "square-kanban",
      stage: "Dev cycle",
      pluginId: PLUGIN_ID,
    });
    this.plugin = plugin;
  }

  async render() {
    await this.refresh(true);
  }

  async refresh(firstRender = false) {
    const p = this.plugin;
    const r = this.regions;
    if (!r) return;

    if (firstRender) setStatus(r.statusEl, "Reading board…", "info");
    await p.loadBoard();
    await p.loadBigBoard(); // initiative chips on card faces
    setShellHealth(r.healthEl, p.boardHealth());

    this.renderActions(r.actionsEl);

    const c = r.contentEl;
    c.empty();

    if (!p.board) {
      const empty = c.createDiv({ cls: "sdd-empty" });
      empty.createDiv({ cls: "sdd-empty__title", text: "Board record unreadable." });
      empty.createDiv({ cls: "sdd-empty__sub", text: p.lastError || "" });
      setStatus(r.statusEl, p.lastError || "Board missing", "error");
      return;
    }

    if (p.bootstrapWarning) c.createDiv({ cls: "sdd-bootstrap", text: `Dev Board: ${p.bootstrapWarning}` }); // [sifi]
    this.renderBoard(c);
    this.renderDebriefs(c);
    this.renderMeetingNotes(c);
    this.renderMaintenance();

    setStatus(
      r.statusEl,
      `Updated ${new Date().toLocaleTimeString()} · record: ${p.settings.boardPath} (agents write it directly)`,
      "info"
    );
  }

  renderActions(el) {
    const p = this.plugin;
    el.empty();

    const capture = el.createDiv({ cls: "sdd-capture" });
    const input = capture.createEl("input", {
      type: "text",
      cls: "sdd-capture__input",
      placeholder: "Add a change…",
    });
    const colSel = capture.createEl("select", { cls: "dropdown sdd-capture__col" });
    for (const col of p.columns()) {
      const opt = colSel.createEl("option", { text: col.label });
      opt.value = col.id;
    }
    colSel.value = "ideas";
    const subSel = capture.createEl("select", {
      cls: "dropdown sdd-capture__subsystem",
      attr: { "aria-label": "Optional subsystem" },
    });
    const noSubsystem = subSel.createEl("option", { text: "Subsystem (optional)" });
    noSubsystem.value = "";
    for (const value of p.subsystemValues()) {
      const option = subSel.createEl("option", { text: value });
      option.value = value;
    }
    const addBtn = capture.createEl("button", { text: "Add", cls: "mod-cta" });
    const doAdd = async () => {
      const title = input.value.trim();
      if (!title) {
        this.openNewCardModal({ column: colSel.value, subsystem: subSel.value || null });
        return;
      }
      await p.addCard({
        title,
        column: colSel.value,
        subsystem: subSel.value || null,
        source: "owner",
        origin: "board",
      });
      input.value = "";
      new Notice("Card added");
      this.refresh();
    };
    addBtn.addEventListener("click", doAdd);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") doAdd();
    });

    // Portfolio altitude one hop away.
    const bigBtn = el.createEl("button", { cls: "sdd-bigboard-link", text: "Big Board" });
    bigBtn.addEventListener("click", () => p.activateBigBoardView());

    const btns = el.createDiv({ cls: "sdd-actionbtns" });
    // One room, column-dependent: Review opens the review
    // room with its queue selector — pick the column to work there. The
    // separate Sort button is retired; its queue lives in the selector.
    const shipped = (p.board?.cards || []).filter((c) => c.column === "shipped").length;
    const review = btns.createEl("button", {
      cls: "mod-cta",
      // "Staging" retired: the room outgrew the name when it
      // went column-dependent — it IS the review room, so the button says so.
      text: shipped ? `Review (${shipped})` : "Review",
      attr: { title: "Work a column card by card — Shipped sign-off, backlog sort, Prototype, Finalize" },
    });
    review.addEventListener("click", () => p.activateReviewView());
    // Filter by Big Board initiative: scan any column and
    // see which initiative each card serves — or which cards serve none.
    const initiatives = (p.bigBoard?.initiatives || []).filter((b) => (b.dd || []).length);
    if (initiatives.length) {
      const initiativeSel = btns.createEl("select", { cls: "dropdown sdd-initiativefilter", attr: { "aria-label": "Filter by Big Board initiative" } });
      const allCards = [...(p.board?.cards || [])];
      const linkedIds = new Set(initiatives.flatMap((b) => b.dd || []));
      const unassigned = allCards.filter((c) => !linkedIds.has(c.id)).length;
      initiativeSel.createEl("option", { value: "", text: `All initiatives (${allCards.length})` });
      // No diamonds; each option carries its live card count.
      for (const initiative of initiatives) {
        const live = (initiative.dd || []).filter((id) => allCards.some((c) => c.id === id)).length;
        initiativeSel.createEl("option", { value: initiative.id, text: `${initiative.title} (${live})` });
      }
      initiativeSel.createEl("option", { value: "__none__", text: `Unassigned (${unassigned})` });
      initiativeSel.value = this._initiativeFilter || "";
      initiativeSel.addEventListener("change", () => {
        this._initiativeFilter = initiativeSel.value;
        this.applyBoardFilter();
      });
    }
    // Search lives as an icon in this row, expanding in place — not its own
    // UI line.
    const searchWrap = btns.createDiv({ cls: ["sdd-searchwrap", this._boardQuery ? "is-open" : ""] });
    const searchBtn = searchWrap.createEl("button", { cls: "sdd-searchwrap__btn", attr: { "aria-label": "Search cards" } });
    setIcon(searchBtn, "search");
    const searchIn = searchWrap.createEl("input", {
      type: "search",
      cls: "sdd-searchwrap__input",
      placeholder: "Search cards…",
      value: this._boardQuery || "",
    });
    searchBtn.addEventListener("click", () => {
      searchWrap.toggleClass("is-open", !searchWrap.hasClass("is-open"));
      if (searchWrap.hasClass("is-open")) searchIn.focus();
      else if (searchIn.value) {
        searchIn.value = "";
        this._boardQuery = "";
        this.applyBoardFilter();
      }
    });
    searchIn.addEventListener("input", () => {
      this._boardQuery = searchIn.value;
      this.applyBoardFilter();
    });
    searchIn.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        searchIn.value = "";
        this._boardQuery = "";
        this.applyBoardFilter();
        searchWrap.removeClass("is-open");
      }
    });
    this.addButton(btns, "Refresh", () => this.refresh());
    this.addButton(btns, "Meeting notes", () =>
      p.app.workspace.openLinkText(p.settings.notesPath, "", false)
    );
  }

  /** Live board filter: matches title, summary, details,
   *  id, subsystem. Empty query = full board. */
  applyBoardFilter() {
    const q = (this._boardQuery || "").trim().toLowerCase();
    const initiativeFilter = this._initiativeFilter || "";
    const root = this.regions?.contentEl;
    if (!root) return;
    root.querySelectorAll(".sdd-card").forEach((el) => {
      const queryMiss = !!q && !(el.dataset.search || "").includes(q);
      const initiativeMiss = initiativeFilter === "__none__" ? !!el.dataset.initiative
        : initiativeFilter ? el.dataset.initiative !== initiativeFilter : false;
      el.toggleClass("sdd-card--hidden", queryMiss || initiativeMiss);
    });
    root.querySelectorAll(".sdd-col").forEach((colEl) => {
      const total = colEl.querySelectorAll(".sdd-card").length;
      const shown = colEl.querySelectorAll(".sdd-card:not(.sdd-card--hidden)").length;
      const count = colEl.querySelector(".sdd-col__count");
      if (count) count.setText(q ? `${shown}/${total}` : String(total));
    });
  }

  renderBoard(parent) {
    const p = this.plugin;
    const board = parent.createDiv({ cls: "sdd-board" });
    const cards = p.board.cards || [];

    for (const col of p.columns()) {
      const colEl = board.createDiv({ cls: ["sdd-col", `sdd-col--${col.id}`] });
      const inCol = cards.filter((c) => c.column === col.id);
      // [sifi] dd-20260821-2fqz: on desktop an empty column collapses to a slim stub so
      // active lanes get the width. It stays a live drop target (dragover expands it
      // through CSS) and a click opens it in place.
      if (inCol.length === 0 && p.settings.collapseEmptyColumns !== false && !(this.app && this.app.isMobile)) {
        colEl.classList.add("sdd-col--collapsed");
        colEl.addEventListener("click", () => colEl.classList.toggle("sdd-col--collapsed"));
      }

      const head = colEl.createDiv({ cls: "sdd-col__head" });
      head.createSpan({ cls: "sdd-col__label", text: col.label });
      head.createSpan({ cls: "sdd-col__count", text: String(inCol.length) });

      const body = colEl.createDiv({ cls: "sdd-col__body" });
      body.addEventListener("dragover", (e) => {
        e.preventDefault();
        colEl.addClass("sdd-col--over");
      });
      body.addEventListener("dragleave", () => colEl.removeClass("sdd-col--over"));
      body.addEventListener("drop", async (e) => {
        e.preventDefault();
        colEl.removeClass("sdd-col--over");
        const id = e.dataTransfer.getData("text/plain");
        if (id) {
          await p.moveCard(id, col.id);
          this.refresh();
        }
      });

      if (inCol.length === 0) {
        body.createDiv({ cls: "sdd-col__empty", text: "—" });
      }
      for (const card of inCol) this.renderCard(body, card);
    }
    // A persisted query survives refresh — re-apply it over the fresh DOM.
    this.applyBoardFilter();
  }

  renderCard(parent, card) {
    const p = this.plugin;
    const el = parent.createDiv({
      cls: ["sdd-card", card.source === "agent" ? "sdd-card--agent" : ""],
      attr: { draggable: "true" },
    });
    const initiative = p.initiativeForCard(card.id);
    el.dataset.search = [card.title, card.summary, card.details, card.id, card.subsystem, initiative?.title]
      .filter(Boolean).join(" ").toLowerCase();
    el.dataset.initiative = initiative ? initiative.id : "";
    el.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", card.id);
      e.dataTransfer.effectAllowed = "move";
      el.addClass("sdd-card--dragging");
    });
    el.addEventListener("dragend", () => el.removeClass("sdd-card--dragging"));

    const title = el.createDiv({ cls: "sdd-card__title", text: card.title });
    title.addEventListener("click", () => this.openCardModal(card));

    if (card.summary) {
      const summary = el.createDiv({ cls: "sdd-card__summary" });
      renderLinkedText(p, summary, card.summary);
    }

    // First "Your next step" item from the card note, on the face.
    const stepEl = el.createDiv({ cls: "sdd-card__nextstep" });
    p.nextStepsFor(card).then((steps) => {
      if (!steps.length || !stepEl.isConnected) return;
      // Full text linkified; the CSS nowrap+ellipsis handles truncation so a
      // wikilink or URL is never cut mid-token.
      stepEl.setAttr("title", "Your next step:\n" + steps.map((s, i) => `${i + 1}. ${s}`).join("\n"));
      stepEl.appendText("→ 1. ");
      renderLinkedText(p, stepEl, steps[0]);
      stepEl.addEventListener("click", (e) => {
        if (e.target.tagName === "A") return;
        p.app.workspace.openLinkText(card.file, "", false);
      });
    });

    const chips = el.createDiv({ cls: "sdd-card__chips" });
    chips.createSpan({
      cls: ["sdd-chip", card.source === "agent" ? "sdd-chip--agent" : "sdd-chip--owner"],
      text: card.source === "agent" ? p.settings.agentLabel : p.settings.ownerLabel,
    });
    if (card.subsystem) chips.createSpan({ cls: "sdd-chip", text: card.subsystem });
    // Big Board initiative, readable from the board itself.
    if (initiative) {
      const initiativeChip = chips.createSpan({
        cls: "sdd-chip sdd-chip--initiative",
        text: initiative.title,
        attr: { title: `Big Board initiative: ${initiative.title} — click to open the Big Board` },
      });
      initiativeChip.addEventListener("click", (e) => {
        e.stopPropagation();
        p.activateBigBoardView();
      });
    }
    if (card.details) {
      chips.createSpan({
        cls: "sdd-chip sdd-chip--details",
        text: "≡ spec",
        attr: { title: card.details },
      });
    }
    if (card.images?.length) {
      chips.createSpan({
        cls: "sdd-chip sdd-chip--images",
        text: `▣ ${card.images.length}`,
        attr: { title: `${card.images.length} screenshot${card.images.length === 1 ? "" : "s"} — open the card to view` },
      });
    }
    if (card.file) {
      const note = chips.createSpan({
        cls: "sdd-chip sdd-chip--file",
        text: "✎ note",
        attr: { title: card.file },
      });
      note.addEventListener("click", () =>
        p.app.workspace.openLinkText(card.file, "", false)
      );
    }
    if (card.feedback) {
      chips.createSpan({
        cls: "sdd-chip sdd-chip--feedback",
        text: "⟲ feedback",
        attr: { title: `Feedback left ${String(card.feedback).replace("T", " ")} — read the card note's User Feedback section` },
      });
    }
    if (card.project) {
      const proj = chips.createSpan({
        cls: "sdd-chip sdd-chip--project",
        text: card.project.split("/").pop().replace(/\.md$/, ""),
        attr: { title: card.project },
      });
      proj.addEventListener("click", () =>
        p.app.workspace.openLinkText(card.project, "", false)
      );
    }
    chips.createSpan({
      cls: "sdd-card__age",
      text: timeAgo(new Date(card.updated || card.created).getTime()),
    });

    const foot = el.createDiv({ cls: "sdd-card__foot" });
    const cols = p.columns();
    const idx = cols.findIndex((c) => c.id === card.column);
    const prev = foot.createEl("button", { cls: "sdd-move", text: "◀" });
    prev.disabled = idx <= 0;
    prev.addEventListener("click", async () => {
      await p.moveCard(card.id, cols[idx - 1].id);
      this.refresh();
    });
    const next = foot.createEl("button", { cls: "sdd-move", text: "▶" });
    next.disabled = idx >= cols.length - 1;
    next.addEventListener("click", async () => {
      await p.moveCard(card.id, cols[idx + 1].id);
      this.refresh();
    });
    const more = foot.createEl("button", { cls: "sdd-move sdd-move--menu", text: "⋯" });
    more.addEventListener("click", (e) => this.showCardMenu(e, card));
  }

  showCardMenu(evt, card) {
    const p = this.plugin;
    const menu = new Menu();
    for (const col of p.columns()) {
      if (col.id === card.column) continue;
      menu.addItem((i) =>
        i.setTitle(`Move to ${col.label}`).setIcon("arrow-right").onClick(async () => {
          await p.moveCard(card.id, col.id);
          this.refresh();
        })
      );
    }
    menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle("Edit…").setIcon("pencil").onClick(() => this.openCardModal(card))
    );
    menu.addItem((i) =>
      i.setTitle(card.file ? "Open card note" : "Create card note").setIcon("file-pen").onClick(async () => {
        await p.ensureSpecOnNote(card);
        const path = card.file || (await p.ensureCardFile(card));
        p.app.workspace.openLinkText(path, "", false);
        this.refresh();
      })
    );
    if (card.project) {
      menu.addItem((i) =>
        i.setTitle("Open project note").setIcon("file-text").onClick(() =>
          p.app.workspace.openLinkText(card.project, "", false)
        )
      );
    }
    menu.addItem((i) =>
      i.setTitle("Archive").setIcon("archive").onClick(async () => {
        await p.archiveCard(card.id);
        new Notice(`Archived: ${card.title}`);
        this.refresh();
      })
    );
    menu.showAtMouseEvent(evt);
  }

  openCardModal(card) {
    new CardModal(this.plugin.app, this.plugin, card, () => this.refresh()).open();
  }

  openNewCardModal(defaults = {}) {
    const now = localIso();
    this.openCardModal({
      id: null,
      title: "",
      summary: "",
      details: null,
      column: defaults.column || "ideas",
      source: "owner",
      origin: "board",
      project: null,
      subsystem: defaults.subsystem || null,
      created: now,
      updated: now,
      history: [],
    });
  }

  /** Session debriefs: the post-review pages — one per work session, each
   *  showing how many of its cards still sit in Shipped awaiting sign-off. */
  renderDebriefs(parent) {
    const p = this.plugin;
    if (!p.debriefs.length) return;
    const box = parent.createDiv({ cls: "sdd-notes sdd-debriefs" });
    const head = box.createDiv({ cls: "sdd-notes__head" });
    head.createSpan({ cls: "sdd-notes__title", text: "Session debriefs" });
    head.createSpan({
      cls: "sdd-notes__sub",
      text: "One review page per session — open the newest and work its queue",
    });

    const list = box.createDiv({ cls: "sdd-notes__list" });
    for (const d of p.debriefs.slice(0, 10)) {
      const row = list.createDiv({ cls: "sdd-noterow" });
      row.createSpan({ cls: "sdd-noterow__date", text: d.date });
      const body = row.createDiv({ cls: "sdd-noterow__body" });
      body.createSpan({ cls: "sdd-noterow__title", text: d.title.replace(/^\d{4}-\d{2}-\d{2}\s*/, "") || d.title });

      const toReview = d.cards.filter((id) => p.findCard(id)?.column === "shipped").length;
      row.createSpan({
        cls: ["sdd-chip", toReview ? "sdd-chip--toreview" : "sdd-chip--placed"],
        text: d.cards.length
          ? toReview
            ? `${toReview} of ${d.cards.length} to review`
            : `Reviewed · ${d.cards.length} cards`
          : "No cards listed",
      });

      const open = row.createEl("button", { cls: "sdd-noterow__promote", text: "Open" });
      open.addEventListener("click", () =>
        p.app.workspace.getLeaf(false).openFile(d.file)
      );
      if (toReview) {
        const review = row.createEl("button", { cls: "sdd-noterow__promote", text: "Review" });
        review.addEventListener("click", () => p.activateReviewView(d.cards));
      }
    }
  }

  renderMeetingNotes(parent) {
    const p = this.plugin;
    const box = parent.createDiv({ cls: "sdd-notes" });
    const head = box.createDiv({ cls: "sdd-notes__head" });
    head.createSpan({ cls: "sdd-notes__title", text: "Product meeting notes" });
    head.createSpan({
      cls: "sdd-notes__sub",
      text: "Your agent's running recommendation log — promote entries onto the board",
    });
    const open = head.createEl("button", { text: "Open note" });
    open.addEventListener("click", () =>
      p.app.workspace.openLinkText(p.settings.notesPath, "", false)
    );

    const list = box.createDiv({ cls: "sdd-notes__list" });
    const entries = p.noteEntries.slice(0, 20);
    if (entries.length === 0) {
      list.createDiv({ cls: "sdd-col__empty", text: "No recommendations logged yet." });
      return;
    }
    for (const entry of entries) {
      const row = list.createDiv({ cls: "sdd-noterow" });
      row.createSpan({ cls: "sdd-noterow__date", text: entry.date || "—" });
      const body = row.createDiv({ cls: "sdd-noterow__body" });
      body.createSpan({ cls: "sdd-noterow__title", text: entry.title });
      if (entry.summary) body.createSpan({ cls: "sdd-noterow__sum", text: " — " + entry.summary });

      const card = p.findCard(entry.id);
      const archived = !card && (p.board?.archive || []).some((c) => c.id === entry.id);
      row.createSpan({
        cls: [
          "sdd-chip",
          card && card.column !== "recommended" ? "sdd-chip--placed" : "",
        ],
        text: card ? p.columnLabel(card.column) : archived ? "Archived" : "Not on board",
      });

      const promote = row.createEl("button", { cls: "sdd-noterow__promote", text: "Promote" });
      promote.addEventListener("click", (e) => {
        const menu = new Menu();
        for (const col of p.columns()) {
          if (card && col.id === card.column) continue;
          menu.addItem((i) =>
            i.setTitle(`→ ${col.label}`).onClick(async () => {
              await p.promoteEntry(entry, col.id);
              new Notice(`${entry.title} → ${col.label}`);
              this.refresh();
            })
          );
        }
        menu.showAtMouseEvent(e);
      });
    }
  }

  renderMaintenance() {
    const p = this.plugin;
    const m = this.regions.maintenanceEl;
    m.empty();
    const cards = p.board?.cards || [];
    const counts = p
      .columns()
      .map((c) => `${c.label}: ${cards.filter((x) => x.column === c.id).length}`)
      .join(" · ");
    m.createDiv({
      cls: "sdd-stats",
      text:
        `${counts} · Archived: ${(p.board?.archive || []).length}. ` +
        "The board JSON is the single source of truth; external writers (your AI agents or " +
        "scripts) append event files next to it, so cards appear here without a reload.",
    });
    const btns = m.createDiv({ cls: "sdd-maint__btns" });
    this.addButton(btns, "Open board JSON", () => p.openInDefaultApp(p.settings.boardPath));
    this.addButton(btns, "Docs", () => window.open(DOCS_URL));
  }

  addButton(parent, label, onClick) {
    const btn = parent.createEl("button", { text: label });
    btn.addEventListener("click", onClick);
    return btn;
  }
}

/**
 * Markdown-aware keys for a plain textarea: Enter continues - / - [ ] / 1.
 * lists (and clears an empty item), Tab / Shift+Tab indent the line, and
 * Cmd/Ctrl+B / I wrap the selection.
 */
function attachMarkdownEditingKeys(textarea) {
  const wrapSelection = (marker) => {
    const { selectionStart: a, selectionEnd: b, value } = textarea;
    textarea.setRangeText(`${marker}${value.slice(a, b)}${marker}`, a, b, "select");
    textarea.setSelectionRange(a + marker.length, b + marker.length);
  };
  textarea.addEventListener("keydown", (evt) => {
    if ((evt.metaKey || evt.ctrlKey) && (evt.key === "b" || evt.key === "i")) {
      evt.preventDefault();
      wrapSelection(evt.key === "b" ? "**" : "*");
      return;
    }
    const { selectionStart: a, selectionEnd: b, value } = textarea;
    const lineStart = value.lastIndexOf("\n", a - 1) + 1;
    if (evt.key === "Tab") {
      evt.preventDefault();
      if (evt.shiftKey) {
        if (value.slice(lineStart, lineStart + 2) === "  ") {
          textarea.setRangeText("", lineStart, lineStart + 2, "preserve");
          textarea.setSelectionRange(Math.max(lineStart, a - 2), Math.max(lineStart, b - 2));
        }
      } else {
        textarea.setRangeText("  ", lineStart, lineStart, "preserve");
        textarea.setSelectionRange(a + 2, b + 2);
      }
      return;
    }
    if (evt.key === "Enter" && !evt.shiftKey && a === b) {
      const line = value.slice(lineStart, a);
      const match = line.match(/^(\s*)(- \[[ x]\] |- |\* |(\d+)\. )(.*)$/);
      if (!match) return;
      evt.preventDefault();
      const [, indent, bullet, num, rest] = match;
      if (!rest.trim()) {
        // Empty list item: Enter clears it (native Obsidian behavior).
        textarea.setRangeText("\n", lineStart, a, "end");
        return;
      }
      let next = bullet.startsWith("- [") ? "- [ ] " : bullet;
      if (num) next = `${Number(num) + 1}. `;
      textarea.setRangeText(`\n${indent}${next}`, a, a, "end");
    }
  });
}

// ─── Dev Board Review — click-through review room over the Shipped column ───
// One card at a time: the card + spec + screen links on the left, the rendered
// card note (feedback trail, screenshots, next steps) on the right, and a route
// bar — Approve → Reviewed, Needs work → Building (feedback required), Not sold,
// Reject. Launch: board "Review shipped" button, a debrief row's Review button,
// or obsidian://select-dev-dashboard-review (optional ?cards=id,id scope).
class ReviewView extends ShellItemView {
  constructor(leaf, plugin) {
    super(leaf, {
      viewType: REVIEW_VIEW_TYPE,
      title: "Dev Board Review",
      icon: "clipboard-check",
      stage: "Review",
      pluginId: PLUGIN_ID,
    });
    this.plugin = plugin;
    this.queueIds = plugin._pendingReviewIds || null;
    plugin._pendingReviewIds = null;
    // "shipped" = sign-off over Shipped; "triage" = decide the backlog
    // (Recommended + Ideas, ).
    this.mode = plugin._pendingReviewMode || "shipped";
    plugin._pendingReviewMode = null;
    this.index = 0;
    this._drafts = new Map(); // card id → unsent feedback text, survives refresh
    this._fbIn = null;
    this._fbCardId = null;
  }

  async render() {
    if (this.containerEl && this.containerEl.classList) this.containerEl.classList.add("sdd-review-fit"); // [sifi] dd-20260821-d1vo
    await this.refresh(true);
  }

  /** Column-dependent queue: the room works whichever
   *  column the selector picks — "shipped" (sign-off, default), "triage"
   *  (Recommended + Ideas backlog), or any single working column ("next",
   *  "finalize", "building", "notsold"). A debrief's explicit id list scopes
   *  and orders the shipped queue. */
  queue() {
    const cards = this.plugin.board?.cards || [];
    if (this.mode === "triage") {
      return [
        ...cards.filter((c) => c.column === "recommended"),
        ...cards.filter((c) => c.column === "ideas"),
      ];
    }
    if (this.mode !== "shipped") return cards.filter((c) => c.column === this.mode);
    const shipped = cards.filter((c) => c.column === "shipped");
    if (!this.queueIds) return shipped;
    const order = new Map(this.queueIds.map((id, i) => [id, i]));
    return shipped
      .filter((c) => order.has(c.id))
      .sort((a, b) => order.get(a.id) - order.get(b.id));
  }

  /** The selector's queue options, with live counts — one option per column,
   *  nothing grouped ( the old "Sort · Recommended + Ideas"
   *  pairing is gone). Shipped first because sign-off is the room's default. */
  queueOptions() {
    const cards = this.plugin.board?.cards || [];
    const count = (col) => cards.filter((c) => c.column === col).length;
    return ["shipped", "recommended", "ideas", "next", "finalize", "building", "notsold", "reviewed", "lived"]
      .map((key) => [key, `${this.plugin.columnLabel(key)} (${count(key)})`]);
  }

  saveDraft() {
    if (this._fbIn && this._fbCardId) {
      const text = this._fbIn.value;
      if (text.trim()) this._drafts.set(this._fbCardId, text);
      else this._drafts.delete(this._fbCardId);
    }
  }

  async refresh(firstRender = false) {
    const p = this.plugin;
    const r = this.regions;
    if (!r) return;
    this.saveDraft();
    this._fbIn = null;
    this._fbCardId = null;

    if (firstRender) setStatus(r.statusEl, "Reading board…", "info");
    await p.loadBoard();
    setShellHealth(r.healthEl, p.boardHealth());

    r.actionsEl.empty();
    r.maintenanceEl.empty();
    const c = r.contentEl;
    c.empty();

    if (!p.board) {
      setStatus(r.statusEl, p.lastError || "Board missing", "error");
      return;
    }

    const q = this.queue();
    if (this.index >= q.length) this.index = Math.max(0, q.length - 1);

    // Top bar: queue selector, progress, prev/next, queue dots, scope, board link.
    const bar = r.actionsEl.createDiv({ cls: "sdd-review__bar" });
    // Column selector: pick which column you're working —
    // this one control replaced the board's separate Sort button.
    const queueSel = bar.createEl("select", { cls: "sdd-review__queuesel", attr: { "aria-label": "Which column to work" } });
    for (const [key, label] of this.queueOptions()) queueSel.createEl("option", { value: key, text: label });
    // "triage" survives as the Sort command's entry mode but is no longer a
    // dropdown option — it displays as Recommended.
    queueSel.value = this.mode === "triage" ? "recommended" : this.mode;
    queueSel.addEventListener("change", () => {
      this.mode = queueSel.value;
      this.queueIds = null;
      this.index = 0;
      this.refresh();
    });
    const prevB = bar.createEl("button", { text: "◀" });
    prevB.disabled = this.index <= 0;
    prevB.addEventListener("click", () => {
      this.index -= 1;
      this.refresh();
    });
    bar.createSpan({
      cls: "sdd-review__progress",
      text: q.length
        ? `${this.index + 1} of ${q.length} to ${this.mode === "triage" ? "triage" : this.mode === "shipped" ? "review" : "work"}`
        : "Queue clear",
    });
    const nextB = bar.createEl("button", { text: "▶" });
    nextB.disabled = this.index >= q.length - 1;
    nextB.addEventListener("click", () => {
      this.index += 1;
      this.refresh();
    });
    const dots = bar.createDiv({ cls: "sdd-review__dots" });
    q.forEach((card, i) => {
      const dot = dots.createEl("button", {
        cls: ["sdd-review__dot", i === this.index ? "is-current" : ""],
        text: String(i + 1),
        attr: { title: card.title },
      });
      dot.addEventListener("click", () => {
        this.index = i;
        this.refresh();
      });
    });
    if (this.queueIds) {
      const scope = bar.createEl("button", {
        cls: "sdd-review__scope",
        text: "Debrief scope · show all shipped",
        attr: { title: "Reviewing only this debrief's cards — click to widen to the whole Shipped column" },
      });
      scope.addEventListener("click", () => {
        this.queueIds = null;
        this.index = 0;
        this.refresh();
      });
    }
    const boardB = bar.createEl("button", { cls: "sdd-review__board", text: "Board" });
    boardB.addEventListener("click", () => p.activateView());
    // Ideas arrive mid-review: capture a NEW card without
    // polluting the card under review — lands in Ideas, queue position kept.
    // Undo the last route: a wrong click at the bottom is
    // reversible from up here, next to + New card.
    if (this._lastRoute) {
      const undo = bar.createEl("button", {
        cls: "sdd-review__undo",
        text: `↩ Undo: ${this._lastRoute.title.slice(0, 24)}${this._lastRoute.title.length > 24 ? "…" : ""} → ${p.columnLabel(this._lastRoute.to)}`,
        attr: { title: `Put "${this._lastRoute.title}" back in ${p.columnLabel(this._lastRoute.from)}` },
      });
      undo.addEventListener("click", async () => {
        const move = this._lastRoute;
        this._lastRoute = null;
        const live = p.findCard(move.cardId);
        if (live) {
          const ts = localIso();
          (live.history = live.history || []).push({
            ts, action: `undo — moved ${live.column} → ${move.from}`, by: "owner",
          });
          live.column = move.from;
          live.updated = ts;
          await p.saveBoard();
          new Notice(`Undone — back in ${p.columnLabel(move.from)}: ${move.title}`);
        }
        this.refresh();
      });
    }
    const addB = bar.createEl("button", {
      cls: "sdd-review__add",
      text: "+ New card",
      attr: { title: "Capture a new idea as its own card (goes to Ideas) — the card you're reviewing stays put" },
    });
    addB.addEventListener("click", () => {
      const now = localIso();
      new CardModal(p.app, p, {
        id: null,
        title: "",
        summary: "",
        details: null,
        column: "ideas",
        source: "owner",
        origin: "review",
        project: null,
        subsystem: null,
        created: now,
        updated: now,
      }, () => this.refresh()).open();
    });

    if (!q.length) {
      const done = c.createDiv({ cls: "sdd-review__done" });
      done.createDiv({
        cls: "sdd-review__done-title",
        text: this.mode === "triage" ? "Backlog triaged." : this.mode === "shipped" ? "Review complete." : "Column clear.",
      });
      done.createDiv({
        cls: "sdd-review__done-sub",
        text: this.mode === "triage"
          ? "Nothing is waiting in Recommended or Ideas."
          : this.queueIds
          ? "Every card in this debrief has been routed."
          : `Nothing is waiting in ${p.columnLabel(this.mode)}. Pick another queue above.`,
      });
      setStatus(r.statusEl, "Queue clear", "ok");
      return;
    }

    const card = q[this.index];
    await this.renderCard(c, card);
    setStatus(
      r.statusEl,
      `${card.id} · ${p.columnLabel(card.column).toLowerCase()} ${timeAgo(new Date(card.updated || card.created).getTime())}`,
      "info"
    );
  }

  async renderCard(parent, card) {
    const p = this.plugin;
    const grid = parent.createDiv({ cls: "sdd-review__grid" });

    // ── Left: the card itself ──
    const left = grid.createDiv({ cls: "sdd-review__cardpane" });
    left.createEl("h3", { cls: "sdd-review__title", text: card.title });
    const chips = left.createDiv({ cls: "sdd-card__chips" });
    // Card id visible on the review screens — not only in
    // the footer status line. Tapping it copies "id — title" for referencing
    // the card back in a chat.
    const idChip = chips.createSpan({
      cls: "sdd-chip sdd-chip--id sdd-chip--copy",
      text: card.id,
      attr: { title: "Copy card id + title", role: "button" },
    });
    idChip.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(`${card.id} — ${card.title}`);
        new Notice("Copied: " + card.id);
      } catch (e) {
        new Notice("Copy failed — select the title text instead");
      }
    });
    chips.createSpan({
      cls: ["sdd-chip", card.source === "agent" ? "sdd-chip--agent" : "sdd-chip--owner"],
      text: card.source === "agent" ? p.settings.agentLabel : p.settings.ownerLabel,
    });
    if (card.subsystem) chips.createSpan({ cls: "sdd-chip", text: card.subsystem });
    if (card.feedback) {
      chips.createSpan({
        cls: "sdd-chip sdd-chip--feedback",
        text: "⟲ feedback pending",
        attr: { title: `Feedback left ${String(card.feedback).replace("T", " ")} — not yet addressed` },
      });
    }
    // Origin context: before anything asks the owner to judge the card, the
    // left pane says whose card this is — their verbatim capture, or an agent
    // recommendation with its why stated as such.
    const ORIGIN_LABELS = {
      chat: "chat close-out", board: "typed on the board", briefing: "a briefing",
      import: "imported", "daily-log": "your daily log", review: "captured mid-review", runner: "a runner",
    };
    const born = String(card.created || "").slice(0, 10);
    const originBox = left.createDiv({ cls: "sdd-review__origin" });
    if (card.source === "owner") {
      originBox.createDiv({
        cls: "sdd-review__origin-head",
        text: `✍️ Your card — ${ORIGIN_LABELS[card.origin] || card.origin || "captured"}, ${born}. Your exact text:`,
      });
      originBox.createDiv({ cls: "sdd-review__origin-body", text: `“${card.title}”` });
    } else {
      originBox.createDiv({
        cls: "sdd-review__origin-head",
        text: `💡 ${p.settings.agentLabel} recommended this (${ORIGIN_LABELS[card.origin] || card.origin || "recommendation"}, ${born}) — why:`,
      });
      const why = card.summary || String(card.details || "").split(/\n/).map((l) => l.trim()).find(Boolean) || "";
      const whyEl = originBox.createDiv({ cls: "sdd-review__origin-body" });
      if (why) renderLinkedText(p, whyEl, why);
      else whyEl.setText("No recorded why — the spec below is the fullest context.");
    }
    if (card.summary && card.source === "owner") {
      const sum = left.createDiv({ cls: "sdd-review__summary" });
      renderLinkedText(p, sum, card.summary);
    }
    if (card.details) {
      const spec = left.createEl("details", { cls: "sdd-review__spec" });
      spec.createEl("summary", { text: "Spec" });
      const specBody = spec.createDiv({ cls: "sdd-review__specbody" });
      renderLinkedText(p, specBody, card.details);
    }

    // Screens: every obsidian:// or http(s) link on the card or its note, one
    // button each — the "go look at the output" row.
    let noteBody = "";
    if (card.file) {
      await p.ensureSpecOnNote(card);
      const f = p.app.vault.getAbstractFileByPath(card.file);
      if (f) {
        try {
          noteBody = await p.app.vault.cachedRead(f);
        } catch (e) {
          /* note unreadable — panes show the empty state */
        }
      }
    }
    const urls = [...new Set(collectUrls(`${card.summary || ""}\n${card.details || ""}\n${noteBody}`))].slice(0, 8);
    if (urls.length) {
      const screens = left.createDiv({ cls: "sdd-review__screens" });
      screens.createDiv({ cls: "sdd-review__label", text: "Screens" });
      const row = screens.createDiv({ cls: "sdd-review__screenrow" });
      for (const url of urls) {
        let label;
        if (url.startsWith("obsidian://")) {
          label = url.slice("obsidian://".length).split("?")[0] || "obsidian";
        } else {
          try {
            label = new URL(url).hostname.replace(/^www\./, "");
          } catch (e) {
            label = url.slice(0, 30);
          }
        }
        const b = row.createEl("button", { cls: "sdd-review__screen", text: `↗ ${label}`, attr: { title: url } });
        b.addEventListener("click", () => window.open(url));
      }
    }

    // Card screenshots: card.images always render here,
    // even when the note never embedded them — an attached shot was
    // invisible in review otherwise. Click opens the lightbox.
    if (card.images?.length) {
      const shots = left.createDiv({ cls: "sdd-review__shots" });
      shots.createDiv({ cls: "sdd-review__label", text: "Screenshots on the card" });
      const strip = shots.createDiv({ cls: "sdd-review__shotstrip" });
      for (const imgPath of card.images) {
        const f = p.app.vault.getAbstractFileByPath(imgPath);
        if (!f) continue;
        const img = strip.createEl("img", {
          cls: "sdd-review__shot",
          attr: { src: p.app.vault.getResourcePath(f), alt: imgPath.split("/").pop() },
        });
        img.addEventListener("click", () => openImageLightbox(img.src, img.alt));
      }
    }

    // Screenshots paste straight into the review room:
    // saved to Attachments and added to card.images immediately, so they can't
    // be lost with an unsent draft. A review paste is feedback, so the embeds
    // land as a dated owner entry under User Feedback — with the current draft
    // text riding along when there is one.
    grid.addEventListener("paste", async (evt) => {
      const items = [...(evt.clipboardData?.items || [])].filter((it) => it.type.startsWith("image/"));
      if (!items.length) return;
      evt.preventDefault();
      this.saveDraft();
      const saved = [];
      for (const it of items) {
        const blob = it.getAsFile();
        if (!blob) continue;
        saved.push(await p.saveCardImage(card.id, await blob.arrayBuffer(), saved.length + 1));
      }
      if (!saved.length) return;
      const live = p.findCard(card.id) || card;
      live.images = [...(live.images || []), ...saved];
      await p.saveBoard();
      const draft = (this._fbCardId === card.id && this._fbIn?.value.trim()) || "";
      const embeds = saved.map((s) => `![[${s}]]`).join("\n");
      await p.recordCardFeedback(
        live,
        draft ? `${draft}\n${embeds}` : embeds,
        `screenshot${saved.length === 1 ? "" : "s"} added in review feedback`
      );
      if (draft) this._drafts.delete(card.id);
      new Notice(`${saved.length} screenshot${saved.length === 1 ? "" : "s"} attached as feedback`);
      this.refresh();
    });

    // Feedback: draft survives navigation; sent on Send or with Needs work.
    const fb = left.createDiv({ cls: "sdd-review__feedback" });
    fb.createDiv({ cls: "sdd-review__label", text: `Feedback for ${p.settings.agentLabel} — paste an image to attach it` });
    this._fbIn = fb.createEl("textarea", {
      cls: "sdd-review__fbbody",
      attr: { rows: "4", placeholder: "What's off, what's missing, what you'd change…" },
    });
    this._fbCardId = card.id;
    this._fbIn.value = this._drafts.get(card.id) || "";
    const fbSend = fb.createEl("button", { cls: "sdd-review__fbsend", text: "Send feedback" });
    fbSend.addEventListener("click", async () => {
      const text = this._fbIn.value.trim();
      if (!text) {
        new Notice("Write the feedback first.");
        this._fbIn.focus();
        return;
      }
      await p.recordCardFeedback(card, text);
      this._drafts.delete(card.id);
      new Notice("Feedback recorded on the card note.");
      this.refresh();
    });

    // ── Right: the output — card note rendered (screenshots, next steps, trail) ──
    const right = grid.createDiv({ cls: "sdd-review__notepane" });
    if (card.images?.length && !noteBody) {
      const strip = right.createDiv({ cls: "sdd-review__images" });
      for (const path of card.images) {
        const f = p.app.vault.getAbstractFileByPath(path);
        if (!f) continue;
        const img = strip.createEl("img", {
          cls: "sdd-review__image",
          attr: { src: p.app.vault.getResourcePath(f), alt: path },
        });
        img.addEventListener("click", () =>
          openImageLightbox(p.app.vault.getResourcePath(f), path)
        );
      }
    }
    if (noteBody) {
      const noteEl = right.createDiv({ cls: "sdd-review__note markdown-rendered" });
      const body = noteBody.replace(/^---\n[\s\S]*?\n---\n/, "");
      await MarkdownRenderer.render(p.app, body, noteEl, card.file, this);
      wireRenderedContent(p, noteEl, card.file);
      decorateNextSteps(noteEl);
      const openNote = right.createEl("button", { cls: "sdd-review__opennote", text: "Open card note" });
      openNote.addEventListener("click", () => p.app.workspace.openLinkText(card.file, "", false));
    } else {
      const empty = right.createDiv({ cls: "sdd-review__noteempty" });
      empty.createDiv({ text: card.file ? "Card note unreadable." : "No card note yet." });
      const mk = empty.createEl("button", { text: card.file ? "Open card note" : "Create card note" });
      mk.addEventListener("click", async () => {
        const path = card.file || (await p.ensureCardFile(card));
        p.app.workspace.openLinkText(path, "", false);
      });
    }

    // ── Route bar — depends on the card's own column,
    // so every queue the selector offers routes sensibly. ──
    const routes = parent.createDiv({ cls: "sdd-review__routes" });
    const routeBtn = (label, toColumn, { cta = false, cls = "" } = {}) => {
      const b = routes.createEl("button", { cls: cta ? "mod-cta" : cls, text: label });
      b.addEventListener("click", () => this.route(card, toColumn, `${p.columnLabel(toColumn)}: ${card.title}`));
      return b;
    };
    const col = card.column;
    if (col === "recommended" || col === "ideas") {
      // Backlog decisions: promote, build now, park, pass.
      routeBtn(`✓ Promote → ${p.columnLabel("next")}`, "next", { cta: true });
      routeBtn(`→ ${p.columnLabel("building")} now`, "building");
      if (col !== "ideas") routeBtn("Park in Ideas", "ideas");
      routeBtn("Not sold", "notsold");
      routeBtn("Reject", "rejected", { cls: "sdd-review__reject" });
      return;
    }
    if (col === "next") {
      routeBtn(`✓ Scope settled → ${p.columnLabel("finalize")}`, "finalize", { cta: true });
      routeBtn(`→ ${p.columnLabel("building")} now`, "building");
      routeBtn("Park in Ideas", "ideas");
      routeBtn("Not sold", "notsold");
      routeBtn("Reject", "rejected", { cls: "sdd-review__reject" });
      return;
    }
    if (col === "finalize") {
      routeBtn(`✓ Build it → ${p.columnLabel("building")}`, "building", { cta: true });
      routeBtn(`Back to ${p.columnLabel("next")}`, "next");
      routeBtn("Not sold", "notsold");
      routeBtn("Reject", "rejected", { cls: "sdd-review__reject" });
      return;
    }
    if (col === "building") {
      routeBtn(`Back to ${p.columnLabel("finalize")}`, "finalize");
      routeBtn("Park in Ideas", "ideas");
      routeBtn("Not sold", "notsold");
      return;
    }
    if (col === "notsold") {
      routeBtn(`✓ Reconsider → ${p.columnLabel("next")}`, "next", { cta: true });
      routeBtn("Park in Ideas", "ideas");
      routeBtn("Reject", "rejected", { cls: "sdd-review__reject" });
      return;
    }
    if (col === "reviewed" || col === "lived") {
      // REVERSE: undo this build — back to the Build
      // column, history records the reversal. Any typed feedback rides along.
      const rev = routes.createEl("button", { cls: "sdd-review__rework", text: "REVERSE: back to Build" });
      rev.addEventListener("click", async () => {
        if (this._routing) return;
        this._routing = true;
        rev.disabled = true;
        try {
          const text = this._fbIn ? this._fbIn.value.trim() : "";
          if (text) {
            await p.feedbackAndMove(card, text, null);
            this._drafts.delete(card.id);
          }
          this._lastRoute = { cardId: card.id, title: card.title, from: card.column, to: "building" };
          await p.reverseToBuild(card.id);
          new Notice(`REVERSED to ${p.columnLabel("building")}: ${card.title}`);
          await this.refresh();
        } finally {
          this._routing = false;
        }
      });
      if (col === "reviewed") routeBtn(`✓ Living with it → ${p.columnLabel("lived")}`, "lived");
      routeBtn("Not sold", "notsold");
      return;
    }
    // Shipped (default sign-off routes).
    const approve = routes.createEl("button", { cls: "mod-cta", text: "✓ Approve → Reviewed" });
    approve.addEventListener("click", () => this.route(card, "reviewed", `Reviewed: ${card.title}`));
    // REVERSE on the shipped queue too — unlike Needs work it requires no
    // feedback text and records a reversal, not a rework, in history.
    const revShipped = routes.createEl("button", { cls: "sdd-review__rework", text: "REVERSE: back to Build" });
    revShipped.addEventListener("click", async () => {
      if (this._routing) return;
      this._routing = true;
      revShipped.disabled = true;
      try {
        const text = this._fbIn ? this._fbIn.value.trim() : "";
        if (text) {
          await p.feedbackAndMove(card, text, null);
          this._drafts.delete(card.id);
        }
        this._lastRoute = { cardId: card.id, title: card.title, from: card.column, to: "building" };
        await p.reverseToBuild(card.id);
        new Notice(`REVERSED to ${p.columnLabel("building")}: ${card.title}`);
        await this.refresh();
      } finally {
        this._routing = false;
      }
    });
    const rework = routes.createEl("button", { cls: "sdd-review__rework", text: `⟲ Needs work → ${p.columnLabel("building")}` });
    rework.addEventListener("click", async () => {
      if (!this._fbIn.value.trim()) {
        new Notice("Add feedback first so your agent knows what to fix.");
        this._fbIn.focus();
        return;
      }
      // route() records the pending feedback before moving the card
      await this.route(card, "building", `Back to ${p.columnLabel("building")}: ${card.title}`);
    });
    const notsold = routes.createEl("button", { text: "Not sold" });
    notsold.addEventListener("click", () => this.route(card, "notsold", `Not sold: ${card.title}`));
    const reject = routes.createEl("button", { cls: "sdd-review__reject", text: "Reject" });
    reject.addEventListener("click", () => this.route(card, "rejected", `Rejected: ${card.title}`));
  }

  async route(card, toColumn, noticeText) {
    if (this._routing) return; // double-click guard
    this._routing = true;
    this.contentEl.querySelectorAll(".sdd-review__routes button").forEach((b) => (b.disabled = true));
    try {
      // Unsent feedback rides along on any route so it can't be lost — and it
      // travels in the SAME board event as the move.
      const text = this._fbIn ? this._fbIn.value.trim() : "";
      // Remember the move for the bar's Undo.
      this._lastRoute = { cardId: card.id, title: card.title, from: card.column, to: toColumn };
      await this.plugin.feedbackAndMove(card, text, toColumn);
      if (text) this._drafts.delete(card.id);
      new Notice(noticeText);
      await this.refresh();
    } finally {
      this._routing = false;
    }
  }
}

class CardModal extends Modal {
  constructor(app, plugin, card, onDone) {
    super(app);
    this.plugin = plugin;
    this.card = card;
    this.onDone = onDone;
  }

  onOpen() {
    const p = this.plugin;
    const card = this.card;
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("sdd-modal");
    this.modalEl.addClass("sdd-modal-window");

    const isNew = !card.id;
    contentEl.createEl("h3", { text: isNew ? "New card" : "Edit card" });

    const meta = contentEl.createDiv({ cls: "sdd-modal__meta" });
    meta.setText(
      isNew
        ? `${p.settings.ownerLabel} · board · card will be created when saved`
        : `${card.source === "agent" ? p.settings.agentLabel : p.settings.ownerLabel} · ${card.origin || "board"} · created ${String(card.created || "").slice(0, 10)} · ${card.id}`
    );

    const titleIn = contentEl.createEl("input", {
      type: "text",
      cls: "sdd-modal__title",
    });
    titleIn.value = card.title;

    const sumIn = contentEl.createEl("textarea", {
      cls: "sdd-modal__summary",
      attr: { placeholder: "One-line summary (shown on the card)" },
    });
    sumIn.value = card.summary || "";
    sumIn.rows = 3;

    const detIn = contentEl.createEl("textarea", {
      cls: "sdd-modal__details",
      attr: {
        placeholder:
          "Implementation detail — enough context to build this without the chat it came from: what/why, files & paths, acceptance criteria, links.",
      },
    });
    detIn.value = card.details || "";
    detIn.rows = 6;

    // Full "Your next step" list from the card note (face shows only step 1).
    const stepsWrap = contentEl.createDiv({ cls: "sdd-modal__nextsteps" });
    if (!isNew && card.file) {
      p.nextStepsFor(card).then((steps) => {
        if (!steps.length) return;
        stepsWrap.createSpan({ cls: "sdd-modal__images-label", text: "Your next step" });
        const list = stepsWrap.createEl("ol");
        for (const step of steps) {
          const item = list.createEl("li");
          renderLinkedText(p, item, step);
        }
      });
    }

    // Card note: the card's own markdown file — editable right here, or open
    // it as a normal note. Pasted screenshots also embed into it.
    this.noteBodyIn = null;
    this.noteBodyOriginal = null;
    const noteWrap = contentEl.createDiv({ cls: "sdd-modal__notefile" });
    const renderNoteSection = async () => {
      noteWrap.empty();
      const head = noteWrap.createDiv({ cls: "sdd-modal__notefile-head" });
      head.createSpan({ cls: "sdd-modal__images-label", text: "Card note" });
      if (card.file && p.app.vault.getAbstractFileByPath(card.file)) {
        const editTab = head.createEl("button", { text: "Edit", cls: "sdd-modal__notetab is-active" });
        const previewTab = head.createEl("button", { text: "Preview", cls: "sdd-modal__notetab" });
        const open = head.createEl("button", { text: "Open note" });
        open.addEventListener("click", () => {
          this.close();
          p.app.workspace.openLinkText(card.file, "", false);
        });
        const body = await p.app.vault.cachedRead(p.app.vault.getAbstractFileByPath(card.file));
        this.noteBodyOriginal = body;
        this.noteBodyIn = noteWrap.createEl("textarea", {
          cls: "sdd-modal__notebody",
          attr: { placeholder: "Card note body" },
        });
        this.noteBodyIn.value = body;
        this.noteBodyIn.rows = 14;
        attachMarkdownEditingKeys(this.noteBodyIn);
        const preview = noteWrap.createDiv({ cls: "sdd-modal__notepreview markdown-rendered" });
        preview.hide();
        const showEdit = () => {
          preview.hide();
          this.noteBodyIn.show();
          editTab.addClass("is-active");
          previewTab.removeClass("is-active");
        };
        const showPreview = async () => {
          preview.empty();
          await MarkdownRenderer.render(p.app, this.noteBodyIn.value, preview, card.file, p);
          wireRenderedContent(p, preview, card.file);
          this.noteBodyIn.hide();
          preview.show();
          previewTab.addClass("is-active");
          editTab.removeClass("is-active");
        };
        editTab.addEventListener("click", showEdit);
        previewTab.addEventListener("click", showPreview);
      } else if (!isNew) {
        const create = head.createEl("button", { text: "Create card note" });
        create.addEventListener("click", async () => {
          await p.ensureCardFile(card);
          await renderNoteSection();
        });
      } else {
        head.createSpan({ cls: "sdd-modal__thumbs-empty", text: "Save the card first, then create its note." });
      }
    };
    renderNoteSection();

    // Feedback: the durable "why is this coming back" channel. Appends a
    // timestamped entry to the card note's User Feedback section on Save and
    // flags the card with a ⟲ feedback chip so the agent can't miss it.
    this.feedbackIn = null;
    if (!isNew) {
      const fbWrap = contentEl.createDiv({ cls: "sdd-modal__feedback" });
      fbWrap.createSpan({ cls: "sdd-modal__images-label", text: `Feedback for ${p.settings.agentLabel}` });
      this.feedbackIn = fbWrap.createEl("textarea", {
        cls: "sdd-modal__feedbackbody",
        attr: { placeholder: "Moving this back? Say why here — it lands in the card note with a timestamp so your agent picks it up next session." },
      });
      this.feedbackIn.rows = 3;
    }

    // Screenshots: paste anywhere in the modal to attach. Existing images render
    // as thumbnails; new pastes stage in memory and write on Save.
    this.keptImages = [...(card.images || [])];
    this.stagedImages = []; // { name, buffer }
    const imgWrap = contentEl.createDiv({ cls: "sdd-modal__images" });
    const renderImages = () => {
      imgWrap.empty();
      imgWrap.createSpan({ cls: "sdd-modal__images-label", text: "Screenshots — paste an image to attach" });
      const strip = imgWrap.createDiv({ cls: "sdd-modal__thumbs" });
      const thumb = (src, label, onRemove, onClick) => {
        const cell = strip.createDiv({ cls: "sdd-modal__thumb" });
        const img = cell.createEl("img", { attr: { src, alt: label } });
        if (onClick) img.addEventListener("click", onClick);
        const x = cell.createEl("button", { cls: "sdd-modal__thumb-x", text: "✕", attr: { "aria-label": `Remove ${label}` } });
        x.addEventListener("click", onRemove);
      };
      for (const path of this.keptImages) {
        const file = p.app.vault.getAbstractFileByPath(path);
        if (!file) continue;
        const src = p.app.vault.getResourcePath(file);
        thumb(
          src,
          path.split("/").pop(),
          () => { this.keptImages = this.keptImages.filter((x) => x !== path); renderImages(); },
          () => openImageLightbox(src, path)
        );
      }
      this.stagedImages.forEach((staged, i) => {
        const blobUrl = URL.createObjectURL(new Blob([staged.buffer], { type: "image/png" }));
        thumb(blobUrl, staged.name, () => { this.stagedImages.splice(i, 1); renderImages(); },
          () => openImageLightbox(blobUrl, staged.name));
      });
      if (!this.keptImages.length && !this.stagedImages.length) {
        strip.createSpan({ cls: "sdd-modal__thumbs-empty", text: "None yet" });
      }
    };
    renderImages();
    contentEl.addEventListener("paste", async (evt) => {
      const items = [...(evt.clipboardData?.items || [])].filter((it) => it.type.startsWith("image/"));
      if (!items.length) return;
      evt.preventDefault();
      for (const it of items) {
        const blob = it.getAsFile();
        if (!blob) continue;
        this.stagedImages.push({ name: `pasted-${this.stagedImages.length + 1}.png`, buffer: await blob.arrayBuffer() });
      }
      renderImages();
    });

    const row = contentEl.createDiv({ cls: "sdd-modal__row" });

    const colWrap = row.createDiv({ cls: "sdd-modal__field" });
    colWrap.createEl("label", { text: "Column" });
    const colSel = colWrap.createEl("select", { cls: "dropdown" });
    for (const col of p.columns()) {
      const opt = colSel.createEl("option", { text: col.label });
      opt.value = col.id;
    }
    colSel.value = card.column;

    const subWrap = row.createDiv({ cls: "sdd-modal__field" });
    subWrap.createEl("label", { text: "Subsystem" });
    const subIn = subWrap.createEl("input", {
      type: "text",
      attr: { list: "sdd-subsystems", placeholder: "e.g. Media Log" },
    });
    subIn.value = card.subsystem || "";
    const subList = subWrap.createEl("datalist", { attr: { id: "sdd-subsystems" } });
    for (const v of p.subsystemValues()) {
      subList.createEl("option", { attr: { value: v } });
    }
    const revealSubsystems = () => {
      if (!subIn.value && typeof subIn.showPicker === "function") subIn.showPicker();
    };
    subIn.addEventListener("focus", revealSubsystems);
    subIn.addEventListener("click", revealSubsystems);

    // Big Board attach: pick the initiative this card
    // rolls up to; saving moves the card's id between initiatives' dd lists.
    const initiativeWrap = row.createDiv({ cls: "sdd-modal__field" });
    initiativeWrap.createEl("label", { text: "Big Board initiative" });
    const initiativeSel = initiativeWrap.createEl("select", { cls: "dropdown" });
    const loadingOpt = initiativeSel.createEl("option", { text: "Loading…" });
    loadingOpt.value = "";
    initiativeSel.disabled = true;
    this.initiativeSel = initiativeSel;
    this.initiativeOriginal = "";
    p.loadBigBoard().then(() => {
      initiativeSel.empty();
      const none = initiativeSel.createEl("option", { text: "— none —" });
      none.value = "";
      const initiatives = p.bigBoard?.initiatives || [];
      if (!initiatives.length) {
        none.text = p.bigBoard ? "No initiatives on the Big Board yet" : "Big Board unavailable";
        return;
      }
      initiativeSel.disabled = false;
      const laneLabel = (id) => p.bigLanes().find((l) => l.id === id)?.label || id;
      for (const initiative of initiatives) {
        const opt = initiativeSel.createEl("option", { text: `${initiative.title} · ${laneLabel(initiative.lane)}` });
        opt.value = initiative.id;
      }
      const current = card.id ? p.initiativeForCard(card.id) : null;
      this.initiativeOriginal = current?.id || "";
      initiativeSel.value = this.initiativeOriginal;
    });

    const projWrap = contentEl.createDiv({ cls: "sdd-modal__field" });
    projWrap.createEl("label", { text: "Project note (deeper entries live in a project file that moves with the card)" });
    const projIn = projWrap.createEl("input", {
      type: "text",
      attr: { list: "sdd-projects", placeholder: "6. Notes/Project.md" },
    });
    projIn.value = card.project || "";
    const projList = projWrap.createEl("datalist", { attr: { id: "sdd-projects" } });
    for (const proj of projectIndex(p.app, p.settings.projectRoot)) {
      projList.createEl("option", { attr: { value: proj.path } });
    }

    const notePaths = new Set();
    if (card.project) notePaths.add(card.project);
    const linkedText = `${card.summary || ""}\n${card.details || ""}`;
    for (const match of linkedText.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)) {
      notePaths.add(match[1].endsWith(".md") ? match[1] : `${match[1]}.md`);
    }
    for (const match of linkedText.matchAll(/(?:^|[\s`(])((?:[0-9A-Za-z][^\n`]*?\/)?[^\n`/]+\.md)(?=$|[\s`),.;])/g)) {
      notePaths.add(match[1].trim());
    }
    const resolvedNotes = [...notePaths]
      .map((path) => ({ path, file: p.app.metadataCache.getFirstLinkpathDest(path.replace(/\.md$/, ""), "") }))
      .filter(({ file }) => file);
    const linkedUrls = [...new Set(collectUrls(linkedText))];
    if (resolvedNotes.length || linkedUrls.length) {
      const notes = contentEl.createDiv({ cls: "sdd-modal__notes" });
      notes.createSpan({ cls: "sdd-modal__notes-label", text: "Linked notes" });
      for (const { file: resolved } of resolvedNotes) {
        const button = notes.createEl("button", {
          cls: "sdd-modal__note-link",
          text: resolved.basename,
        });
        button.setAttr("title", resolved.path);
        button.addEventListener("click", () => p.app.workspace.getLeaf(false).openFile(resolved));
      }
      for (const url of linkedUrls) {
        const label = url.startsWith("obsidian://")
          ? url.replace(/^obsidian:\/\//, "").split("?")[0]
          : url.replace(/^https?:\/\//, "").split("/")[0];
        const button = notes.createEl("button", {
          cls: "sdd-modal__note-link sdd-modal__note-link--url",
          text: `↗ ${label}`,
        });
        button.setAttr("title", url);
        button.addEventListener("click", () => window.open(url));
      }
    }

    const btns = contentEl.createDiv({ cls: "sdd-modal__btns" });
    // Reverse a build: built cards (Shipped / Reviewed /
    // Lived) get a one-click reversal back to Build, recorded as such in
    // history so the trail reads "reverted", not just another move.
    if (!isNew && ["shipped", "reviewed", "lived"].includes(card.column)) {
      const revert = btns.createEl("button", {
        cls: "sdd-modal__revert",
        text: "REVERSE: back to Build",
        attr: { title: "Yes — the card returns to the Build column and its history records the reversal of this build" },
      });
      revert.addEventListener("click", async () => {
        revert.disabled = true;
        await p.reverseToBuild(card.id);
        new Notice(`REVERSED to ${p.columnLabel("building")}: ${card.title}`);
        this.close();
        this.onDone?.();
      });
    }
    const save = btns.createEl("button", { text: "Save", cls: "mod-cta" });
    save.addEventListener("click", async () => {
      const title = titleIn.value.trim();
      if (!title) {
        new Notice("Title required");
        return;
      }
      const fields = {
        title,
        summary: sumIn.value.trim(),
        details: detIn.value.trim() || null,
        column: colSel.value,
        subsystem: normalizeSubsystem(subIn.value),
        project: projIn.value.trim() || null,
      };
      save.disabled = true;
      const cardId = card.id || p.newCardId();
      const imagePaths = [...this.keptImages];
      const newImagePaths = [];
      for (let i = 0; i < this.stagedImages.length; i++) {
        try {
          const saved = await p.saveCardImage(cardId, this.stagedImages[i].buffer, i + 1);
          imagePaths.push(saved);
          newImagePaths.push(saved);
        } catch (error) {
          new Notice(`Saving screenshot failed: ${error.message || error}`);
          save.disabled = false;
          return;
        }
      }
      fields.images = imagePaths;
      if (isNew) {
        await p.addCard({ ...fields, id: cardId, source: "owner", origin: "board" });
        new Notice("Card added");
      } else {
        await p.updateCard(card.id, fields);
      }
      if (this.initiativeSel && !this.initiativeSel.disabled && this.initiativeSel.value !== this.initiativeOriginal) {
        try {
          await p.linkCardToInitiative(cardId, this.initiativeSel.value || null);
        } catch (error) {
          new Notice(`Big Board link failed: ${error.message || error}`);
        }
      }
      if (card.file && p.app.vault.getAbstractFileByPath(card.file)) {
        try {
          if (this.noteBodyIn && this.noteBodyIn.value !== this.noteBodyOriginal) {
            const file = p.app.vault.getAbstractFileByPath(card.file);
            await guardWrite("Saving the card note", () => p.app.vault.modify(file, this.noteBodyIn.value));
          }
          if (newImagePaths.length) await p.appendImagesToCardFile(card.file, newImagePaths);
        } catch (error) {
          new Notice(`Card note update failed: ${error.message || error}`);
        }
      }
      if (this.feedbackIn && this.feedbackIn.value.trim()) {
        try {
          await p.recordCardFeedback(p.findCard(cardId) || card, this.feedbackIn.value);
          new Notice("Feedback recorded");
        } catch (error) {
          new Notice(`Feedback save failed: ${error.message || error}`);
        }
      }
      this.close();
      this.onDone();
    });
    const cancel = btns.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());

    if (card.history?.length) {
      const hist = contentEl.createEl("details", { cls: "sdd-modal__hist" });
      hist.createEl("summary", { text: "History" });
      for (const h of [...card.history].reverse().slice(0, 10)) {
        hist.createDiv({
          cls: "sdd-modal__histrow",
          text: `${String(h.ts || "").replace("T", " ")} — ${h.action} (${h.by})`,
        });
      }
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

class DevBoardSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h3", { text: "Dev Board" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Plumbing only. Cards, columns, and meeting notes are managed in the board view; external writers edit the same records directly.",
    });
    const bind = (name, desc, key, { allowEmpty = false } = {}) =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((t) =>
          t.setValue(this.plugin.settings[key]).onChange(async (v) => {
            this.plugin.settings[key] = allowEmpty ? v.trim() : v.trim() || DEFAULT_SETTINGS[key];
            await this.plugin.saveSettings();
          })
        );
    bind("Board record path", "Vault-relative path to board.json (shared with external writers).", "boardPath");
    bind("Big Board record path", "Vault-relative path to big_board.json (portfolio initiatives).", "bigBoardPath");
    bind("Meeting notes path", "Vault-relative path to the append-only recommendations journal.", "notesPath");
    bind("Debriefs folder", "Vault-relative folder holding per-session debrief notes.", "debriefsPath");
    bind("Project root", "Folder scanned for #project notes in the project autocomplete. Empty scans the whole vault.", "projectRoot", { allowEmpty: true });
    bind("Your name", "Label shown on cards you create.", "ownerLabel");
    bind("Agent name", "Label shown on cards created by an external writer (source: \"agent\").", "agentLabel");
    bind("Subsystems", "Comma-separated subsystem labels always offered in pickers (card values are added automatically).", "subsystems", { allowEmpty: true });
    // [sifi] Sifi's edition
    containerEl.createEl("h3", { text: "Sifi's edition" });
    new Setting(containerEl)
      .setName("Collapse empty columns")
      .setDesc("On desktop, an empty column shrinks to a slim stub; drag over it or click it to open it.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.collapseEmptyColumns !== false).onChange(async (v) => {
          this.plugin.settings.collapseEmptyColumns = v;
          await this.plugin.saveSettings();
        })
      );
  }
}

// ---------------------------------------------------------------------------
// Big Board: the higher-altitude portfolio kanban —
// theme lanes × status columns (Direction B), big initiatives only. One Big Board initiative
// ↔ many dd- implementation cards; the linked-cards chip is read live from
// board.json. Ships blank; the Recommendations section below the grid carries
// the prototype's seeded placements for one-tap adoption.
class InitiativeModal extends Modal {
  constructor(app, plugin, { initiative, onSave } = {}) {
    super(app);
    this.plugin = plugin;
    this.initiative = initiative || null;
    this.onSave = onSave;
  }

  onOpen() {
    const p = this.plugin;
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("sdd-big__modal");
    contentEl.createEl("h3", { text: this.initiative ? "Edit initiative" : "Add an initiative" });
    const value = {
      title: this.initiative?.title || "",
      why: this.initiative?.why || "",
      lane: this.initiative?.lane || p.bigLanes()[0]?.id,
      column: this.initiative?.column || "idea",
      dd: (this.initiative?.dd || []).join(", "),
    };
    let titleIn;
    new Setting(contentEl).setName("Initiative").addText((t) => {
      titleIn = t;
      t.setValue(value.title).onChange((v) => (value.title = v));
      t.inputEl.style.width = "100%";
    });
    new Setting(contentEl).setName("One-line why").addText((t) => {
      t.setValue(value.why).onChange((v) => (value.why = v));
      t.inputEl.style.width = "100%";
    });
    new Setting(contentEl).setName("Lane").addDropdown((d) => {
      for (const lane of p.bigLanes()) d.addOption(lane.id, lane.label);
      d.setValue(value.lane).onChange((v) => (value.lane = v));
    });
    new Setting(contentEl).setName("Column").addDropdown((d) => {
      for (const col of p.bigColumns()) d.addOption(col.id, col.label);
      d.setValue(value.column).onChange((v) => (value.column = v));
    });
    new Setting(contentEl)
      .setName("Linked dd- cards")
      .setDesc("Comma-separated dd- ids; drives the live in-flight/shipped chip.")
      .addText((t) => {
        t.setValue(value.dd).onChange((v) => (value.dd = v));
        t.inputEl.style.width = "100%";
      });
    new Setting(contentEl).addButton((b) =>
      b.setButtonText(this.initiative ? "Save" : "Add to board").setCta().onClick(async () => {
        if (!value.title.trim()) {
          titleIn.inputEl.focus();
          return;
        }
        const dd = value.dd.split(",").map((s) => s.trim()).filter(Boolean);
        await this.onSave({ ...value, title: value.title.trim(), dd });
        this.close();
      })
    );
  }

  onClose() {
    this.contentEl.empty();
  }
}

class BigBoardView extends ShellItemView {
  constructor(leaf, plugin) {
    super(leaf, {
      viewType: BIG_VIEW_TYPE,
      title: "Big Board",
      icon: "map",
      stage: "Portfolio",
      pluginId: PLUGIN_ID,
    });
    this.plugin = plugin;
  }

  async render() {
    await this.refresh();
  }

  async refresh() {
    const p = this.plugin;
    await p.loadBoard();
    await p.loadBigBoard();
    const r = this.regions;
    if (!r) return;
    r.actionsEl.empty();
    r.contentEl.empty();
    r.maintenanceEl.empty();

    setShellHealth(r.healthEl, computeHealth([
      p.bigError
        ? { state: HEALTH.BROKEN, reason: p.bigError }
        : { state: HEALTH.HEALTHY, reason: "big_board.json readable" },
    ]));
    if (!p.bigBoard) {
      setStatus(r.statusEl, p.bigError || "No big_board.json yet.", "error");
      return;
    }

    // Actions bar: altitude reminder + add door + board cross-link.
    const bar = r.actionsEl.createDiv({ cls: "sdd-big__bar" });
    bar.createSpan({
      cls: "sdd-big__hint",
      text: "Whole initiatives — broad strokes. Implementation cards stay on the Dev Board.",
    });
    const addBtn = bar.createEl("button", { cls: "mod-cta", text: "+ Add an initiative" });
    addBtn.addEventListener("click", () =>
      new InitiativeModal(p.app, p, {
        onSave: async (v) => {
          await p.addInitiative(v);
          this.refresh();
        },
      }).open()
    );
    const boardBtn = bar.createEl("button", { text: "Dev Board ▸" });
    boardBtn.addEventListener("click", () => p.activateView());

    this.renderGrid(r.contentEl);
    this.renderRecommendations(r.contentEl);

    const maint = r.maintenanceEl;
    const open = (label, path) => {
      const b = maint.createEl("button", { text: label });
      b.addEventListener("click", () => p.app.workspace.openLinkText(path, "", false));
    };
    open("Open big_board.json", p.settings.bigBoardPath);
    setStatus(
      r.statusEl,
      `${(p.bigBoard.initiatives || []).length} initiative(s) on the board · ${(p.bigBoard.recommendations || []).length} recommendation(s) below`,
      "info"
    );
  }

  renderGrid(parent) {
    const p = this.plugin;
    const lanes = p.bigLanes();
    const cols = p.bigColumns();
    const grid = parent.createDiv({ cls: "sdd-big" });
    grid.style.setProperty("--sdd-big-cols", String(cols.length));

    // Header row: corner + column heads with blurbs.
    grid.createDiv({ cls: "sdd-big__corner" });
    for (const col of cols) {
      const head = grid.createDiv({ cls: "sdd-big__colhead" });
      head.createDiv({ cls: "sdd-big__collabel", text: col.label });
      if (col.blurb) head.createDiv({ cls: "sdd-big__colblurb", text: col.blurb });
    }

    for (const lane of lanes) {
      const laneHead = grid.createDiv({ cls: "sdd-big__lanehead" });
      laneHead.createDiv({ cls: "sdd-big__lanelabel", text: lane.label });
      for (const col of cols) {
        const cell = grid.createDiv({ cls: "sdd-big__cell" });
        cell.addEventListener("dragover", (e) => {
          e.preventDefault();
          cell.addClass("sdd-big__cell--over");
        });
        cell.addEventListener("dragleave", () => cell.removeClass("sdd-big__cell--over"));
        cell.addEventListener("drop", async (e) => {
          e.preventDefault();
          cell.removeClass("sdd-big__cell--over");
          const id = e.dataTransfer.getData("text/plain");
          if (id) {
            await p.moveInitiative(id, lane.id, col.id);
            this.refresh();
          }
        });
        const initiatives = (p.bigBoard.initiatives || []).filter(
          (b) => b.lane === lane.id && b.column === col.id
        );
        // Empty cells stay visible — the gaps are signal (locked design).
        if (!initiatives.length) cell.createDiv({ cls: "sdd-big__empty", text: "—" });
        for (const initiative of initiatives) this.renderInitiative(cell, initiative);
      }
    }
  }

  renderInitiative(parent, initiative) {
    const p = this.plugin;
    const el = parent.createDiv({ cls: "sdd-big__initiative", attr: { draggable: "true" } });
    el.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", initiative.id);
      e.dataTransfer.effectAllowed = "move";
      el.addClass("sdd-card--dragging");
    });
    el.addEventListener("dragend", () => el.removeClass("sdd-card--dragging"));
    const title = el.createDiv({ cls: "sdd-big__initiativetitle", text: initiative.title });
    title.addEventListener("click", () =>
      new InitiativeModal(p.app, p, {
        initiative,
        onSave: async (v) => {
          Object.assign(initiative, { title: v.title, why: v.why, dd: v.dd, updated: localIso() });
          if (v.lane !== initiative.lane || v.column !== initiative.column) {
            await p.moveInitiative(initiative.id, v.lane, v.column);
          } else {
            await p.saveBigBoard();
          }
          this.refresh();
        },
      }).open()
    );
    if (initiative.why) el.createDiv({ cls: "sdd-big__initiativewhy", text: initiative.why });
    const stats = p.initiativeStats(initiative);
    if (stats) {
      el.createDiv({
        cls: "sdd-big__ddchip",
        text: `${stats.inFlight} in flight / ${stats.shipped} shipped`,
        attr: { title: `${stats.linked} linked dd- card(s): ${(initiative.dd || []).join(", ")}` },
      });
    }
    const foot = el.createDiv({ cls: "sdd-card__foot" });
    const cols = p.bigColumns();
    const idx = cols.findIndex((c) => c.id === initiative.column);
    const prev = foot.createEl("button", { cls: "sdd-move", text: "◀" });
    prev.disabled = idx <= 0;
    prev.addEventListener("click", async () => {
      await p.moveInitiative(initiative.id, initiative.lane, cols[idx - 1].id);
      this.refresh();
    });
    const next = foot.createEl("button", { cls: "sdd-move", text: "▶" });
    next.disabled = idx >= cols.length - 1;
    next.addEventListener("click", async () => {
      await p.moveInitiative(initiative.id, initiative.lane, cols[idx + 1].id);
      this.refresh();
    });
    const more = foot.createEl("button", { cls: "sdd-move sdd-move--menu", text: "⋯" });
    more.addEventListener("click", (e) => {
      const menu = new Menu();
      for (const col of cols) {
        if (col.id === initiative.column) continue;
        menu.addItem((i) =>
          i.setTitle(`Move to ${col.label}`).setIcon("arrow-right").onClick(async () => {
            await p.moveInitiative(initiative.id, initiative.lane, col.id);
            this.refresh();
          })
        );
      }
      menu.addSeparator();
      for (const lane of p.bigLanes()) {
        if (lane.id === initiative.lane) continue;
        menu.addItem((i) =>
          i.setTitle(`Lane: ${lane.label}`).setIcon("rows-3").onClick(async () => {
            await p.moveInitiative(initiative.id, lane.id, initiative.column);
            this.refresh();
          })
        );
      }
      menu.addSeparator();
      menu.addItem((i) =>
        i.setTitle("Remove from board").setIcon("archive").onClick(async () => {
          await p.archiveInitiative(initiative.id);
          this.refresh();
        })
      );
      menu.showAtMouseEvent(e);
    });
  }

  renderRecommendations(parent) {
    const p = this.plugin;
    const recs = p.bigBoard.recommendations || [];
    if (!recs.length) return;
    const box = parent.createDiv({ cls: "sdd-big__recs" });
    box.createEl("h3", { text: "Recommendations" });
    box.createDiv({
      cls: "sdd-big__hint",
      text: "Seeded placements from the prototype — adopt onto the board or dismiss. Your board, your call.",
    });
    for (const rec of recs) {
      const row = box.createDiv({ cls: "sdd-big__rec" });
      const main = row.createDiv({ cls: "sdd-big__recmain" });
      main.createSpan({
        cls: "sdd-big__recplace",
        text: `${p.bigLanes().find((l) => l.id === rec.lane)?.label || rec.lane} · ${
          p.bigColumns().find((c) => c.id === rec.column)?.label || rec.column
        }`,
      });
      main.createSpan({ cls: "sdd-big__rectitle", text: rec.title });
      if (rec.why) main.createSpan({ cls: "sdd-big__recwhy", text: ` — ${rec.why}` });
      const actions = row.createDiv({ cls: "sdd-big__recactions" });
      const add = actions.createEl("button", { cls: "mod-cta", text: "Add to board" });
      add.addEventListener("click", async () => {
        await p.addInitiative({ title: rec.title, why: rec.why, lane: rec.lane, column: rec.column, dd: rec.dd || [] });
        p.bigBoard.recommendations = recs.filter((x) => x !== rec);
        await p.saveBigBoard();
        this.refresh();
      });
      const dismiss = actions.createEl("button", { text: "Dismiss" });
      dismiss.addEventListener("click", async () => {
        p.bigBoard.recommendations = recs.filter((x) => x !== rec);
        (p.bigBoard.dismissed = p.bigBoard.dismissed || []).push({ ...rec, dismissed: localIso() });
        await p.saveBigBoard();
        this.refresh();
      });
    }
  }
}
