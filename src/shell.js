// Shared shell for the Dev Board views: a small plugin scaffold, a standard
// surface layout (header / actions / content / maintenance / status), a
// three-state health marker, and a few formatting helpers. Self-contained so
// the plugin has no dependencies beyond Obsidian itself.

import { ItemView, Notice, Plugin, setIcon } from "obsidian";

// ── Health marker ───────────────────────────────────────────────────────────

export const HEALTH = {
  HEALTHY: "healthy",
  NEEDS_REVIEW: "needs_review",
  BROKEN: "broken",
};

const ORDER = { [HEALTH.HEALTHY]: 0, [HEALTH.NEEDS_REVIEW]: 1, [HEALTH.BROKEN]: 2 };
const LABEL = {
  [HEALTH.HEALTHY]: "Healthy",
  [HEALTH.NEEDS_REVIEW]: "Needs review",
  [HEALTH.BROKEN]: "Broken",
};

/** Roll a list of {state, reason} checks into one worst-state marker. */
export function computeHealth(checks) {
  const list = (checks || []).filter(Boolean);
  if (list.length === 0) return { state: HEALTH.HEALTHY, reason: "No checks", checks: list };
  let worst = list[0];
  for (const c of list) if (ORDER[c.state] > ORDER[worst.state]) worst = c;
  return {
    state: worst.state,
    reason: worst.reason || LABEL[worst.state],
    checks: list,
  };
}

export function renderHealthMarker(el, { state, reason }) {
  const wrap = el.createDiv({ cls: ["dvb-health", `dvb-health--${state}`] });
  wrap.createSpan({ cls: "dvb-health__dot" });
  wrap.createSpan({ cls: "dvb-health__label", text: LABEL[state] || state });
  if (reason) wrap.createSpan({ cls: "dvb-health__reason", text: reason });
  return wrap;
}

// ── Write guard ─────────────────────────────────────────────────────────────

/**
 * Run a vault write and make failure visible: on error, show a Notice with
 * `label` and rethrow so caller semantics are unchanged. A silent unhandled
 * rejection from a click handler reads as a successful save.
 */
export async function guardWrite(label, fn) {
  try {
    return await fn();
  } catch (e) {
    new Notice(`${label} failed: ${e.message || e}`, 8000);
    throw e;
  }
}

// ── Formatting helpers ──────────────────────────────────────────────────────

const pad2 = (n) => String(n).padStart(2, "0");

/** Local-time ISO seconds ("2026-07-11T14:07:56") — records are local time. */
export function localIso(d = new Date()) {
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
    `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}

/** Compact relative time ("4 min ago", "3 h ago", "2 d ago"). */
export function timeAgo(ts) {
  const tsMs =
    typeof ts === "number" ? ts : ts instanceof Date ? ts.getTime() : ts ? Date.parse(ts) : NaN;
  if (!tsMs || Number.isNaN(tsMs)) return "—";
  const min = Math.max(0, Math.floor((Date.now() - tsMs) / 60000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.floor(min / 60)} h ago`;
  return `${Math.floor(min / 1440)} d ago`;
}

/**
 * Every #project note under `root` (frontmatter tag or inline #project).
 * An empty root scans the whole vault. Returns [{name, path}].
 */
export function projectIndex(app, root) {
  const out = [];
  for (const f of app.vault.getMarkdownFiles()) {
    if (root && !f.path.startsWith(root + "/")) continue;
    const cache = app.metadataCache.getFileCache(f);
    const fmTags = cache?.frontmatter?.tags;
    const fmList = Array.isArray(fmTags) ? fmTags : typeof fmTags === "string" ? [fmTags] : [];
    const inline = (cache?.tags || []).map((t) => t.tag);
    if (fmList.some((t) => String(t).toLowerCase() === "project") || inline.includes("#project")) {
      out.push({ name: f.basename, path: f.path });
    }
  }
  return out;
}

// ── Surface shell ───────────────────────────────────────────────────────────

/** Icon-only gear that opens the plugin's settings tab, inside a header row. */
export function addSettingsGear(parentEl, app, pluginId, label = "Plugin settings") {
  const gear = parentEl.createEl("button", {
    cls: ["dvb-surface__gear", "clickable-icon"],
    attr: { "aria-label": label, title: label },
  });
  setIcon(gear, "settings");
  gear.addEventListener("click", () => {
    app.setting.open();
    app.setting.openTabById(pluginId);
  });
  return gear;
}

/**
 * Build the standard surface shell inside `containerEl`. Returns the region
 * elements the caller fills in: header, healthEl, actionsEl, contentEl,
 * maintenanceEl, statusEl.
 */
export function buildShell(containerEl, { title, stage, settings } = {}) {
  containerEl.empty();
  const root = containerEl.createDiv({ cls: "dvb-surface" });

  const header = root.createDiv({ cls: "dvb-surface__header" });
  const titleWrap = header.createDiv({ cls: "dvb-surface__titlewrap" });
  if (title) titleWrap.createEl("h2", { cls: "dvb-surface__title", text: title });
  if (stage) titleWrap.createSpan({ cls: "dvb-surface__stage", text: stage });
  const healthEl = header.createDiv({ cls: "dvb-surface__health" });
  if (settings && settings.app && settings.pluginId) {
    addSettingsGear(header, settings.app, settings.pluginId, settings.label);
  }

  const actionsEl = root.createDiv({ cls: "dvb-surface__actions" });
  const contentEl = root.createDiv({ cls: "dvb-surface__content" });

  const maintenance = root.createEl("details", { cls: "dvb-surface__maintenance" });
  maintenance.createEl("summary", { text: "Config & maintenance" });
  const maintenanceEl = maintenance.createDiv({ cls: "dvb-surface__maintenance-body" });

  const statusEl = root.createDiv({ cls: "dvb-surface__status" });

  return { root, header, healthEl, actionsEl, contentEl, maintenanceEl, statusEl };
}

/** Set (or replace) the health marker in a shell's health region. */
export function setShellHealth(healthEl, health) {
  healthEl.empty();
  if (health) renderHealthMarker(healthEl, health);
}

/** Write a status line into a shell's status region. `kind` ∈ ok|warn|error|info. */
export function setStatus(statusEl, message, kind = "info") {
  statusEl.empty();
  if (!message) return;
  statusEl.createSpan({
    cls: ["dvb-status", `dvb-status--${kind}`],
    text: message,
  });
}

// ── Plugin scaffold ─────────────────────────────────────────────────────────

/**
 * Shared plugin scaffold: subclasses declare views, ribbon, command, protocol
 * handler, settings tab, and defaults once via scaffold(), and keep only
 * genuinely custom code.
 *
 * scaffold() config: viewType (required), view (required, (leaf) => ItemView),
 * ribbon {icon,label}, command {id,name}, protocol name, settingsTab () => tab,
 * refreshMs, defaults, normalizeSettings(data).
 */
export class ShellPlugin extends Plugin {
  scaffold() {
    throw new Error(`${this.constructor.name} must implement scaffold()`);
  }

  async initState() {}
  async afterLoad() {}
  applyViewArg(_view, _arg) {}
  stashPending(arg) {
    this.pendingViewArg = arg;
  }

  async onload() {
    const c = (this._scaffold = this.scaffold());
    await this.loadSettings();
    await this.initState();

    this.registerView(c.viewType, (leaf) => c.view(leaf));
    if (c.ribbon) this.addRibbonIcon(c.ribbon.icon, c.ribbon.label, () => this.activateView());
    if (c.command) {
      this.addCommand({ id: c.command.id, name: c.command.name, callback: () => this.activateView() });
    }
    if (c.protocol) {
      const name = typeof c.protocol === "string" ? c.protocol : c.protocol.name;
      const argOf = typeof c.protocol === "object" && c.protocol.arg ? c.protocol.arg : () => undefined;
      this.registerObsidianProtocolHandler(name, (params) => this.activateView(argOf(params)));
    }
    if (c.settingsTab) this.addSettingTab(c.settingsTab());
    if (c.refreshMs) {
      this.registerInterval(window.setInterval(() => this.refreshOpenViews(), c.refreshMs));
    }
    await this.afterLoad();
  }

  async activateView(arg) {
    const { workspace } = this.app;
    const viewType = this._scaffold.viewType;
    let leaf = workspace.getLeavesOfType(viewType)[0];
    if (!leaf) {
      if (arg !== undefined && arg !== null) this.stashPending(arg);
      leaf = workspace.getLeaf(true);
      await leaf.setViewState({ type: viewType, active: true });
    } else {
      if (arg !== undefined && arg !== null) this.applyViewArg(leaf.view, arg);
      if (typeof leaf.view.refresh === "function") await leaf.view.refresh();
    }
    workspace.revealLeaf(leaf);
  }

  async refreshOpenViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(this._scaffold.viewType)) {
      if (typeof leaf.view.refresh === "function") await leaf.view.refresh();
    }
  }

  async loadSettings() {
    const c = this._scaffold || this.scaffold();
    const data = (await this.loadData()) || {};
    this.settings = {
      ...(c.defaults || {}),
      ...data,
      ...(c.normalizeSettings ? c.normalizeSettings(data) : {}),
    };
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

/**
 * Thin base class for a shell view: subclass, pass viewType/title/icon/stage,
 * implement render(regions). Builds the shell on open, exposes this.regions.
 */
export class ShellItemView extends ItemView {
  constructor(leaf, { viewType, title, icon, stage, pluginId } = {}) {
    super(leaf);
    this._viewType = viewType;
    this._title = title;
    this._icon = icon || "layout-dashboard";
    this._stage = stage;
    this._pluginId = pluginId;
    this.regions = null;
  }
  getViewType() { return this._viewType; }
  getDisplayText() { return this._title; }
  getIcon() { return this._icon; }
  async onOpen() {
    this.regions = buildShell(this.contentEl, {
      title: this._title,
      stage: this._stage,
      settings: this._pluginId
        ? { app: this.app, pluginId: this._pluginId, label: `${this._title || "Plugin"} settings` }
        : undefined,
    });
    await this.render(this.regions);
  }
  async onClose() {}
  /** Override in subclass. */
  async render(_regions) {}
}
