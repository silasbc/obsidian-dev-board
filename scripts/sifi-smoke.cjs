// Sifi's edition — bootstrap-guard smoke test (dd-20260831-btsp) plus the
// collapsed-column default (dd-20260821-2fqz). Same mocked-Obsidian harness
// shape as scripts/smoke-test.cjs, against the built main.js.
// Run: node scripts/sifi-smoke.cjs (after npm run build)
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class Plugin {
  constructor(app) {
    this.app = app;
  }
  async loadData() {
    return {};
  }
  async saveData() {}
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
  window: { setTimeout: (fn) => setTimeout(fn, 0), open: () => {} },
  setTimeout,
  clearTimeout,
  Date,
  JSON,
  Math,
});

const DevBoardPlugin = moduleRecord.exports.default || moduleRecord.exports;
assert.equal(typeof DevBoardPlugin, "function", "bundle exports the plugin class");

function makeApp() {
  const files = new Map();
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
  const noteObjs = new Map();
  const noteObj = (p) => {
    if (!noteObjs.has(p)) noteObjs.set(p, { path: p, basename: p.split("/").pop().replace(/\.md$/, ""), stat: { mtime: Date.now() } });
    return noteObjs.get(p);
  };
  const vault = {
    adapter,
    getMarkdownFiles: () => [...files.keys()].filter((f) => f.endsWith(".md")).map((f) => noteObj(f)),
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
    dirs,
  };
}

async function makePlugin(app) {
  const plugin = new DevBoardPlugin(app);
  if (typeof plugin.loadSettings === "function") await plugin.loadSettings();
  plugin.settings = Object.assign(
    {
      boardPath: "Dev Board/board.json",
      notesPath: "Dev Board/Meeting Notes.md",
      debriefsPath: "Dev Board/Debriefs",
      bigBoardPath: "Dev Board/big_board.json",
      projectRoot: "",
      ownerLabel: "Me",
      agentLabel: "Agent",
      subsystems: "",
    },
    plugin.settings || {}
  );
  plugin.board = null;
  plugin.bigBoard = null;
  plugin.noteEntries = [];
  plugin.debriefs = [];
  plugin._saving = false;
  plugin._nextStepCache = new Map();
  return plugin;
}

const EVENT = {
  version: 1,
  event_id: "20260904T120000-lead-session-000001-abcd1234",
  ts: "2026-09-04T12:00:00",
  writer: "lead-session",
  operation: "upsert",
  card_id: "dd-20260904-test",
  card: {
    id: "dd-20260904-test",
    title: "Synced card",
    summary: "",
    details: "",
    column: "next",
    source: "agent",
    origin: "chat",
    subsystem: "Media",
    project: null,
    images: [],
    file: null,
    created: "2026-09-04T12:00:00",
    updated: "2026-09-04T12:00:00",
    history: [{ ts: "2026-09-04T12:00:00", action: "created", by: "lead-session" }],
  },
};

(async () => {
  // A. Truly empty vault → the starter board, no warning (upstream behaviour kept).
  {
    const { app } = makeApp();
    const plugin = await makePlugin(app);
    assert.equal(plugin.settings.collapseEmptyColumns, true, "collapsed empty columns default on");
    await plugin.loadBoard();
    assert.ok(plugin.board, "starter board on a truly empty vault");
    assert.equal(plugin.board.cards.length, 0);
    assert.equal(plugin.bootstrapWarning, null, "no warning on a clean first run");
    await plugin.loadBigBoard();
    assert.ok(plugin.bigBoard, "big board scaffolded on a clean first run");
  }

  // B. Events synced but board.json missing → rebuilt from the event log, not blanked.
  {
    const { app, files } = makeApp();
    files.set("Dev Board/Events/lead-session/20260904T120000-lead-session-000001-abcd1234.json", JSON.stringify(EVENT));
    files.set("Dev Board/Cards/dd-20260904-test Synced card.md", "# Synced card\n");
    const plugin = await makePlugin(app);
    await plugin.loadBoard();
    assert.ok(plugin.board, "board exists after rebuild");
    assert.equal(plugin.board.cards.length, 1, "the synced card came back from the event log");
    assert.equal(plugin.board.cards[0].column, "next");
    assert.match(String(plugin.bootstrapWarning), /rebuilt from 1 event file/, "the board says it rebuilt itself");
    await plugin.loadBigBoard();
    assert.equal(plugin.bigBoard, null, "no blank big board written over a synced one");
    assert.equal(files.has("Dev Board/big_board.json"), false, "big_board.json left absent for sync to fill");
    assert.match(String(plugin.bigError), /not synced/, "the big board explains itself");
  }

  // C. Card notes present but no events or records → the board says so instead of pretending to be empty.
  {
    const { app, files } = makeApp();
    files.set("Dev Board/Cards/dd-20260904-test Synced card.md", "# Synced card\n");
    const plugin = await makePlugin(app);
    await plugin.loadBoard();
    assert.ok(plugin.board, "a columns shell exists so the board can render");
    assert.equal(plugin.board.cards.length, 0);
    assert.match(String(plugin.bootstrapWarning), /1 card note\(s\) are here but no board events/, "warns about unsynced history");
    assert.match(String(plugin.bootstrapWarning), /Sync all other types/, "names the fix");
  }

  // D. An existing board.json is never touched by the guard.
  {
    const { app, files } = makeApp();
    files.set("Dev Board/board.json", JSON.stringify({ version: 1, columns: [{ id: "next", label: "Prototype" }], cards: [], archive: [] }));
    const plugin = await makePlugin(app);
    await plugin.loadBoard();
    assert.equal(plugin.board.columns.length, 1, "existing columns kept");
    assert.equal(plugin.bootstrapWarning, null);
  }

  // E. Auto-advance to Lived: stale Testing/Shipped/Reviewed cards move, fresh ones stay, backlog never, off at 0.
  const stamp = (daysAgo) => { const d = new Date(Date.now() - daysAgo * 86400000); const pad = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
  const mkEvent = (files, id, column, daysAgo, n) => {
    const ts = stamp(daysAgo);
    const eventId = `${ts.replace(/[:+\-.]/g, "")}-lead-session-${String(n).padStart(6, "0")}-deadbeef`;
    files.set(`Dev Board/Events/lead-session/${eventId}.json`, JSON.stringify({ ...EVENT, event_id: eventId, ts, card_id: id, card: { ...EVENT.card, id, title: id, column, created: ts, updated: ts, history: [{ ts, action: `created in ${column}`, by: "lead-session" }] } }));
  };
  {
    const { app, files } = makeApp();
    mkEvent(files, "dd-20260828-stal", "testing", 8, 1);
    mkEvent(files, "dd-20260904-fres", "testing", 1, 2);
    mkEvent(files, "dd-20260801-idea", "ideas", 30, 3);
    mkEvent(files, "dd-20260801-ship", "shipped", 20, 4);
    const plugin = await makePlugin(app);
    assert.equal(plugin.settings.autoLiveDays, 7, "auto-live defaults to 7 days");
    await plugin.loadBoard();
    assert.equal(plugin.findCard("dd-20260828-stal").column, "lived", "8-day-old testing card advanced to lived");
    assert.match(plugin.findCard("dd-20260828-stal").history.slice(-1)[0].action, /auto-advanced testing → lived: 7 days/, "history says why");
    assert.equal(plugin.findCard("dd-20260828-stal").history.slice(-1)[0].by, "dev-board-auto");
    assert.equal(plugin.findCard("dd-20260801-ship").column, "lived", "20-day-old shipped card advanced to lived");
    assert.equal(plugin.findCard("dd-20260904-fres").column, "testing", "fresh card stays");
    assert.equal(plugin.findCard("dd-20260801-idea").column, "ideas", "backlog columns never auto-advance");
    assert.ok([...files.keys()].some((f) => f.includes("/Events/") && String(files.get(f)).includes("auto-advanced")), "the move is an event like any other");
    await plugin.loadBoard();
    assert.equal(plugin.findCard("dd-20260828-stal").history.filter((h) => /auto-advanced/.test(h.action)).length, 1, "a second load does not sweep twice");
  }
  {
    const { app } = makeApp();
    const plugin = await makePlugin(app);
    plugin.settings.autoLiveDays = 0;
    const { files } = { files: null };
    void files;
    const stale = await plugin.addCard({ title: "Old with auto off", column: "shipped", source: "agent" });
    void stale;
  }
  {
    const { app, files } = makeApp();
    mkEvent(files, "dd-20260801-offx", "shipped", 30, 1);
    const plugin = await makePlugin(app);
    plugin.settings.autoLiveDays = 0;
    await plugin.loadBoard();
    assert.equal(plugin.findCard("dd-20260801-offx").column, "shipped", "0 days turns the sweep off");
  }

  // F. Review queue keys follow the board's real columns, Shipped first.
  {
    const { app, files } = makeApp();
    files.set("Dev Board/board.json", JSON.stringify({ version: 1, columns: [{ id: "ideas", label: "Ideas" }, { id: "next", label: "Prototype" }, { id: "testing", label: "Testing" }, { id: "shipped", label: "Shipped" }, { id: "recshare", label: "Recommendations" }], cards: [], archive: [] }));
    const plugin = await makePlugin(app);
    await plugin.loadBoard();
    assert.deepEqual(Array.from(plugin.reviewQueueKeys()), ["shipped", "ideas", "next", "testing", "recshare"], "Shipped first, then the vault's own columns in board order"); // Array.from: the vm realm's arrays fail strict deep-equal
  }

  console.log("Sifi smoke passed: bootstrap guard (clean, events-only, cards-only, existing), big board guard, collapsed-column default, auto-live sweep, review queue keys.");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
