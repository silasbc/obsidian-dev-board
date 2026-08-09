// Mocked-Obsidian contract test for the Dev Board record store: first-run
// bootstrap, card add/move/archive, event emission, reducer convergence and
// commutativity, and next-step parsing. Runs against the built main.js.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class Plugin {
  constructor(app) {
    this.app = app;
  }
}
class ItemView {}
class PluginSettingTab {}
class Setting {}
class Modal {}
class Notice {}
class Menu {}

const source = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
const moduleRecord = { exports: {} };
vm.runInNewContext(source, {
  module: moduleRecord,
  exports: moduleRecord.exports,
  require(name) {
    if (name !== "obsidian") return require(name);
    return {
      Plugin,
      ItemView,
      PluginSettingTab,
      Setting,
      Modal,
      Notice,
      Menu,
      MarkdownRenderer: { render: async () => {} },
      Platform: { isMobile: false },
      setIcon: () => {},
      normalizePath: (value) => value,
    };
  },
  console,
  URL,
  window: { setTimeout: (fn) => setTimeout(fn, 0), open: () => {} },
  setTimeout,
  clearTimeout,
});

const DevBoardPlugin = moduleRecord.exports.default || moduleRecord.exports;
assert.equal(typeof DevBoardPlugin, "function", "bundle exports the plugin class");

// ── In-memory vault + adapter ───────────────────────────────────────────────
function makeApp() {
  const files = new Map(); // path -> string contents
  const dirs = new Set([""]);
  const mkdirp = (dir) => {
    const parts = dir.split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  };
  const adapter = {
    async read(p) {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
      return files.get(p);
    },
    async write(p, text) {
      mkdirp(p.split("/").slice(0, -1).join("/"));
      files.set(p, text);
    },
    async exists(p) {
      return files.has(p) || dirs.has(p);
    },
    async mkdir(p) {
      mkdirp(p);
    },
    async remove(p) {
      files.delete(p);
    },
    async rename(from, to) {
      if (!files.has(from)) throw new Error(`ENOENT: ${from}`);
      files.set(to, files.get(from));
      files.delete(from);
    },
    async list(p) {
      const out = { files: [], folders: [] };
      const seen = new Set();
      for (const f of files.keys()) {
        if (!f.startsWith(p + "/")) continue;
        const rest = f.slice(p.length + 1);
        if (rest.includes("/")) {
          const folder = `${p}/${rest.split("/")[0]}`;
          if (!seen.has(folder)) {
            seen.add(folder);
            out.folders.push(folder);
          }
        } else {
          out.files.push(f);
        }
      }
      for (const d of dirs) {
        if (!d.startsWith(p + "/")) continue;
        const rest = d.slice(p.length + 1);
        if (!rest.includes("/") && !seen.has(d)) {
          seen.add(d);
          out.folders.push(d);
        }
      }
      return out;
    },
  };
  const noteObjs = new Map(); // path -> file object
  const noteObj = (p) => {
    if (!noteObjs.has(p)) noteObjs.set(p, { path: p, basename: p.split("/").pop().replace(/\.md$/, ""), stat: { mtime: Date.now() } });
    return noteObjs.get(p);
  };
  const vault = {
    adapter,
    getMarkdownFiles: () =>
      [...files.keys()].filter((f) => f.endsWith(".md")).map((f) => noteObj(f)),
    getAbstractFileByPath: (p) => (files.has(p) || dirs.has(p) ? noteObj(p) : null),
    async createFolder(p) {
      mkdirp(p);
    },
    async create(p, body) {
      files.set(p, body);
      return noteObj(p);
    },
    async createBinary(p, buf) {
      files.set(p, buf);
      return noteObj(p);
    },
    async read(f) {
      return adapter.read(f.path);
    },
    async cachedRead(f) {
      return adapter.read(f.path);
    },
    async modify(f, body) {
      files.set(f.path, body);
      noteObj(f.path).stat.mtime = Date.now() + Math.random();
    },
    async process(f, fn) {
      files.set(f.path, fn(files.get(f.path)));
    },
    on: () => ({}),
  };
  return {
    app: {
      vault,
      workspace: { getLeavesOfType: () => [], on: () => ({}) },
      metadataCache: { getFileCache: () => null, getFirstLinkpathDest: () => null },
    },
    files,
  };
}

function makePlugin(app) {
  const plugin = new DevBoardPlugin(app);
  plugin.settings = {
    boardPath: "Dev Board/board.json",
    notesPath: "Dev Board/Meeting Notes.md",
    debriefsPath: "Dev Board/Debriefs",
    bigBoardPath: "Dev Board/big_board.json",
    projectRoot: "",
    ownerLabel: "Me",
    agentLabel: "Agent",
    subsystems: "",
  };
  plugin.board = null;
  plugin.bigBoard = null;
  plugin.noteEntries = [];
  plugin.debriefs = [];
  plugin._saving = false;
  plugin._nextStepCache = new Map();
  return plugin;
}

(async () => {
  // ── First-run bootstrap ──
  const { app, files } = makeApp();
  const plugin = makePlugin(app);
  await plugin.loadBoard();
  assert.ok(plugin.board, "starter board created on first run");
  assert.equal(plugin.board.columns.length, 10, "starter board has the full dev cycle");
  assert.equal(plugin.board.cards.length, 0, "starter board is empty");

  // ── addCard: board, event, record, card note ──
  const card = await plugin.addCard({ title: "First card", column: "ideas", source: "owner" });
  assert.ok(card.id.startsWith("dd-"), "card id minted");
  assert.equal(plugin.findCard(card.id).column, "ideas");
  const eventFiles = [...files.keys()].filter((f) => f.includes("/Events/"));
  assert.ok(eventFiles.length >= 1, "board event emitted");
  assert.ok(files.has(`Dev Board/Records/${card.id}.json`), "per-card record reduced");
  assert.ok(files.has(card.file), "card note scaffolded at creation");
  const boardJson = JSON.parse(files.get("Dev Board/board.json"));
  assert.equal(boardJson.cards.length, 1, "board.json rewritten from records");

  // ── moveCard: column + history ──
  await plugin.moveCard(card.id, "building", "owner");
  const moved = plugin.findCard(card.id);
  assert.equal(moved.column, "building");
  assert.ok(
    moved.history.some((h) => /moved ideas → building/.test(h.action) && h.by === "owner"),
    "history records the move with the generic actor"
  );

  // ── external writer event picked up by the reducer ──
  const extTs = "2020-05-01T00:00:00";
  const extEvent = {
    version: 1,
    event_id: `${extTs.replace(/[:+\-.]/g, "")}-agent-writer-abc12345`,
    ts: extTs,
    writer: "agent-writer",
    operation: "upsert",
    card_id: "dd-20200501-test",
    card: {
      id: "dd-20200501-test",
      title: "Agent recommendation",
      column: "recommended",
      source: "agent",
      created: extTs,
      updated: extTs,
      history: [{ ts: extTs, action: "created in recommended", by: "agent" }],
    },
  };
  await app.vault.adapter.write(
    `Dev Board/Events/agent-writer/${extEvent.event_id}.json`,
    JSON.stringify(extEvent, null, 2) + "\n"
  );
  await plugin.loadBoard();
  const agentCard = plugin.findCard("dd-20200501-test");
  assert.ok(agentCard, "external writer's card appears after reduce");
  assert.equal(agentCard.column, "recommended");

  // ── reducer: late older event must not rewind newer state ──
  const oldTs = "2000-01-01T00:00:00";
  await app.vault.adapter.write(
    `Dev Board/Events/agent-writer/${oldTs.replace(/[:+\-.]/g, "")}-agent-writer-old00000.json`,
    JSON.stringify({
      ...extEvent,
      event_id: `${oldTs.replace(/[:+\-.]/g, "")}-agent-writer-old00000`,
      ts: oldTs,
      card: { ...extEvent.card, column: "ideas", title: "Stale title", updated: oldTs },
    }, null, 2) + "\n"
  );
  await plugin.loadBoard();
  const stable = plugin.findCard("dd-20200501-test");
  assert.equal(stable.column, "recommended", "late older event does not rewind the column");
  assert.equal(stable.title, "Agent recommendation", "late older event does not rewind fields");

  // ── merge commutativity: both orders converge byte-identically ──
  const evA = { ts: "2026-01-01T10:00:00", event_id: "a" };
  const evB = { ts: "2026-01-02T10:00:00", event_id: "b" };
  const cardA = { id: "x", title: "A", column: "ideas", history: [{ ts: evA.ts, action: "created", by: "owner" }] };
  const cardB = { id: "x", title: "B", column: "next", history: [{ ts: evB.ts, action: "moved", by: "agent" }] };
  const ab = plugin.mergeCardRecord(plugin.mergeCardRecord(null, cardA, evA), cardB, evB);
  const ba = plugin.mergeCardRecord(plugin.mergeCardRecord(null, cardB, evB), cardA, evA);
  assert.equal(JSON.stringify(ab), JSON.stringify(ba), "merge is commutative");
  assert.equal(ab.title, "B", "newest event wins fields");
  assert.equal(ab.history.length, 2, "history unions");

  // ── archive ──
  await plugin.archiveCard(card.id, "owner");
  assert.equal(plugin.findCard(card.id), null, "archived card leaves the active board");
  assert.ok(plugin.board.archive.some((c) => c.id === card.id), "archived card kept in archive");

  // ── next-step parsing from the card note ──
  const notePath = agentCard.file || (await plugin.ensureCardFile(agentCard));
  await app.vault.adapter.write(
    notePath,
    "---\ndd_id: dd-20200501-test\n---\n\n# Agent recommendation\n\n## Your next step\n\n1. Review the diff\n2. Approve the card\n"
  );
  plugin._nextStepCache.clear();
  const steps = await plugin.nextStepsFor(plugin.findCard("dd-20200501-test"));
  assert.equal(JSON.stringify([...steps]), JSON.stringify(["Review the diff", "Approve the card"]), "next steps parsed from the note");

  // ── big board bootstrap ──
  await plugin.loadBigBoard();
  assert.ok(plugin.bigBoard, "starter big board created");
  assert.equal(plugin.bigBoard.lanes.length, 3);
  const initiative = await plugin.addInitiative({ title: "Ship v1", why: "because", lane: "product", column: "planned" });
  await plugin.linkCardToInitiative("dd-20200501-test", initiative.id);
  assert.equal(plugin.initiativeForCard("dd-20200501-test").id, initiative.id, "card links to one initiative");

  console.log("Smoke test passed: bootstrap, add/move/archive, external events, reducer convergence, next steps, big board.");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
