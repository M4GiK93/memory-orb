"use strict";

const { Plugin, MarkdownRenderChild, Notice } = require("obsidian");
const { buildGraph } = require("./graph");
const { readVaultGraph } = require("./pathways");
const { Orb } = require("./orb");
const { Inspector } = require("./inspector");
const { registerCapture } = require("./capture");
const { neighborhood } = require("./search");

class MemoryView extends MarkdownRenderChild {
    constructor(el, plugin) {
        super(el);
        this.plugin = plugin;
        this.generation = 0;
        this.routePath = "";
        this.step = 0;
        this.history = [];
    }

    onload() {
        this.plugin.views.add(this);
        this.element = this.containerEl.createDiv({ cls: "memory-orb-view" });
        this.picker = this.element.createDiv({ cls: "memory-orb-routes" });
        this.nav = this.element.createDiv({ cls: "memory-orb-steps" });
        const mount = this.element.createDiv();
        this.status = this.element.createDiv({ cls: "memory-orb-index-status" });
        this.status.setAttribute("role", "status");
        this.snapshot();
        this.orb = new Orb(mount, {
            getGraph: query => this.graphFor(query),
            openNote: (path, options) => this.openNote(path, options),
            clearSelection: () => this.clearSelection()
        });
        const { vault, metadataCache } = this.plugin.app;
        this.inspector = new Inspector(this.orb.inspectorMount, {
            getFileInfo: path => this.fileInfo(path),
            readNote: path => {
                const file = vault.getAbstractFileByPath(path);
                if (file?.extension !== "md") throw new Error("Note unavailable");
                return vault.cachedRead(file);
            },
            resolveLink: (target, source) => {
                const link = target.split("#")[0];
                const file = link ? metadataCache.getFirstLinkpathDest(link, source) : vault.getAbstractFileByPath(source);
                return file?.extension === "md" ? file.path : null;
            },
            openPath: path => this.openNote(path),
            goBack: () => {
                if (this.history.length < 2) return;
                this.history.pop();
                this.displaySelection(true);
            },
            close: () => {
                this.clearSelection();
                this.orb.canvas.focus({ preventScroll: true });
            }
        });
        this.button(this.element, "Capture from ChatGPT", () =>
            this.plugin.openCapture(this.history[this.history.length - 1]?.path));
        this.renderRoutes();
    }

    fileInfo(path) {
        const file = this.plugin.app.vault.getAbstractFileByPath(path);
        if (file?.extension !== "md") return null;
        const neighbors = [];
        for (const [a, b] of this.graph.edges) {
            if (a === path) neighbors.push(this.nodesByPath.get(b));
            else if (b === path) neighbors.push(this.nodesByPath.get(a));
        }
        neighbors.sort((a, b) => a.label.localeCompare(b.label) || a.path.localeCompare(b.path));
        return { label: this.nodesByPath.get(path)?.label || file.basename, neighbors,
            revision: file.stat.mtime + "/" + file.stat.size };
    }

    clearSelection() {
        this.history.length = 0;
        this.displaySelection(false);
    }

    openNote(path, options) {
        const file = this.plugin.app.vault.getAbstractFileByPath(path);
        if (file?.extension !== "md") {
            new Notice("This note has moved or was removed.");
            return;
        }
        if (this.history[this.history.length - 1] !== file) this.history.push(file);
        this.displaySelection(true, options);
    }

    displaySelection(reveal, { scrollReader = reveal } = {}) {
        const file = this.history[this.history.length - 1];
        this.orb.setSelection(file?.path || null, { reveal });
        if (!file) {
            this.inspector.clear();
            this.readRevision = null;
            return;
        }
        if (reveal && this.routePath) {
            const route = this.data.routes.find(r => r.path === this.routePath);
            if (route && route.steps[this.step]?.path !== file.path) {
                const index = route.steps.findIndex(s => s.path === file.path);
                if (index >= 0) {
                    this.step = index;
                    this.renderRoutes();
                }
            }
        }
        const revision = file.stat.mtime + "/" + file.stat.size;
        const reload = this.readRevision !== revision;
        this.readRevision = revision;
        this.inspector.show(file.path, this.history.length > 1, { reload, reveal: scrollReader });
    }

    snapshot() {
        this.cancelQuery();
        this.data = readVaultGraph(this.plugin.app);
        this.graph = buildGraph(this.data.notes, this.data.resolvedLinks);
        this.nodesByPath = new Map(this.graph.nodes.map(node => [node.path, node]));
    }

    refresh() {
        if (!this.orb) return;
        const knownRoute = this.data.routes.find(r => r.path === this.routePath);
        const current = knownRoute?.steps[this.step]?.path;
        this.snapshot();
        const route = this.data.routes.find(r => r.path === this.routePath);
        const position = current && route?.steps[this.step]?.path === current
            ? this.step : (route?.steps.findIndex(s => s.path === current) ?? -1);
        this.step = position >= 0 ? position : 0;
        if (!route) this.routePath = "";
        this.orb.refresh();
        this.renderRoutes();
        const vault = this.plugin.app.vault;
        this.history = this.history.filter(f => vault.getAbstractFileByPath(f.path) === f);
        this.displaySelection(false);
    }

    cancelQuery() {
        ++this.generation;
        clearTimeout(this.timer);
        this.query = "";
        this.results = null;
        if (this.status) this.status.textContent = "";
    }

    graphFor(input = "") {
        const query = input.trim().toLowerCase();
        if (this.query === query) return this.results || this.graph;
        this.cancelQuery();
        if (!query) return this.graph;
        this.query = query;
        const metadata = buildGraph(this.data.notes, this.data.resolvedLinks, query);
        const hits = new Set(metadata.nodes.map(n => n.path));
        this.results = { ...neighborhood(this.graph, hits), searching: true };
        this.status.textContent = "Searching note text…";
        const generation = this.generation;
        this.timer = setTimeout(() => this.searchText(query, hits, generation), 200);
        return this.results;
    }

    async searchText(query, hits, generation) {
        const vault = this.plugin.app.vault;
        const candidates = this.data.notes.filter(n => !hits.has(n.path));
        let unavailable = 0;
        for (let i = 0; i < candidates.length; i += 4) {
            if (generation !== this.generation) return;
            await Promise.all(candidates.slice(i, i + 4).map(async note => {
                const file = vault.getAbstractFileByPath(note.path);
                if (file?.extension !== "md") return;
                try {
                    const body = await vault.cachedRead(file);
                    if (generation === this.generation && buildGraph([{ ...note, body }], {}, query).matches)
                        hits.add(note.path);
                } catch { unavailable++; }
            }));
        }
        if (generation !== this.generation) return;
        this.results = neighborhood(this.graph, hits);
        this.status.textContent = unavailable ? "Note text unavailable for " + unavailable + " file(s)." : "";
        this.orb.refresh();
    }

    button(container, label, callback) {
        const button = container.createEl("button", { text: label });
        button.type = "button";
        button.addEventListener("click", callback);
        return button;
    }

    renderRoutes(clearSearch = false) {
        const active = this.element.ownerDocument.activeElement;
        const focusKey = (this.picker.contains(active) || this.nav.contains(active)) ? active?.dataset.key : "";
        this.picker.replaceChildren();
        this.nav.replaceChildren();
        const selected = this.data.routes.find(r => r.path === this.routePath);
        for (const route of this.data.routes) {
            const b = this.button(this.picker, route.label, () => {
                this.routePath = route === selected ? "" : route.path;
                this.step = 0;
                this.renderRoutes(true);
                if (this.history.length && this.routePath && !route.issue)
                    this.openNote(route.steps[0].path);
            });
            b.dataset.key = route.path;
            b.setAttribute("aria-pressed", String(route === selected));
        }
        if (selected) {
            const step = selected.steps[this.step];
            const indicator = this.nav.createDiv({ cls: "memory-orb-step-label" });
            indicator.setAttribute("aria-live", "polite");
            indicator.textContent = selected.issue || ("Step " + (this.step + 1) + " of " + selected.steps.length + " · " + step.label);
            if (!selected.issue) {
                const move = delta => {
                    this.step += delta;
                    this.renderRoutes(true);
                    this.openNote(selected.steps[this.step].path);
                };
                const back = this.button(this.nav, "Previous", () => move(-1));
                back.dataset.key = "previous";
                back.disabled = this.step === 0;
                const next = this.button(this.nav, "Next", () => move(1));
                next.dataset.key = "next";
                next.disabled = this.step === selected.steps.length - 1;
                this.button(this.nav, "Open note", () => this.openNote(step.path)).dataset.key = "open";
            } else this.button(this.nav, "Open pathway note", () => this.openNote(selected.path));
        }
        const steps = selected?.steps || [];
        this.orb.setPathway(steps.map(s => s.path), steps[this.step]?.path || "", { clearSearch });
        if (focusKey) {
            const buttons = [...this.picker.children, ...this.nav.querySelectorAll("button")];
            buttons.find(b => b.dataset.key === focusKey && !b.disabled)?.focus({ preventScroll: true });
        }
    }

    onunload() {
        this.plugin.views.delete(this);
        this.cancelQuery();
        this.inspector?.destroy();
        this.orb?.destroy();
        this.orb = null;
        this.element?.remove();
    }
}

module.exports = class MemoryOrbPlugin extends Plugin {
    onload() {
        this.views = new Set();
        this.openCapture = registerCapture(this);
        const refresh = () => {
            if (!this.views.size) return;
            clearTimeout(this.timer);
            this.timer = setTimeout(() => this.views.forEach(view => view.refresh()), 150);
        };
        const { vault, metadataCache } = this.app;
        for (const event of ["create", "modify", "rename", "delete"])
            this.registerEvent(vault.on(event, refresh));
        for (const event of ["changed", "resolved"])
            this.registerEvent(metadataCache.on(event, refresh));
        this.registerMarkdownCodeBlockProcessor("memory-orb", (_source, el, context) =>
            context.addChild(new MemoryView(el, this)));
    }

    onunload() {
        clearTimeout(this.timer);
        for (const view of this.views) view.unload();
    }
};
