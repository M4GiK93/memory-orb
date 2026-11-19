"use strict";
const graph = (() => { const module = { exports: {} };
"use strict";

const REGIONS = ["short", "long", "synthesis"];

function buildGraph(notes, resolvedLinks, query = "") {
    const words = query.normalize("NFC").trim().toLowerCase().split(/\s+/).filter(Boolean);
    const known = new Set();
    const visible = new Set();
    const nodes = [];

    for (const note of notes) {
        if (!note.path || known.has(note.path)) continue;
        known.add(note.path);
        const label = note.label || note.path.split("/").pop().replace(/\.md$/i, "");
        if (words.length) {
            const fields = [label, note.path].concat(note.aliases || [], note.tags || [], note.headings || []);
            const text = fields.join("\n").normalize("NFC").toLowerCase();
            const missing = words.filter(word => !text.includes(word));
            if (missing.length) {
                const body = (note.body || "").normalize("NFC").toLowerCase();
                if (!missing.every(word => body.includes(word))) continue;
            }
        }
        const folderRegion = /^synthesis\//i.test(note.path) ? "synthesis" : "long";
        const region = REGIONS.includes(note.region) ? note.region : folderRegion;
        nodes.push({ path: note.path, label, region });
        visible.add(note.path);
    }
    nodes.sort((a, b) => a.path.localeCompare(b.path));

    const edges = [];
    const linked = new Set();
    for (const source of visible) {
        for (const target of Object.keys(resolvedLinks?.[source] || {})) {
            if (source === target || !visible.has(target)) continue;
            const edge = source < target ? [source, target] : [target, source];
            const key = edge.join("\0");
            if (linked.has(key)) continue;
            linked.add(key);
            edges.push(edge);
        }
    }
    return { nodes, edges, total: known.size, matches: nodes.length };
}

module.exports = { buildGraph };

return module.exports; })();

const pathways = (() => { const module = { exports: {} };
"use strict";

const REGIONS = ["short", "long", "synthesis"];

function strings(value) {
    return (Array.isArray(value) ? value : [value]).filter(item => typeof item === "string" && item.trim());
}

function sectionLinks(cache, name) {
    const headings = cache.headings || [];
    const start = headings.find(heading => heading.level === 2 && heading.heading === name);
    if (!start) return [];
    const end = headings.find(heading => heading.level <= 2 &&
        heading.position.start.offset > start.position.start.offset);
    const boundary = end?.position.start.offset ?? Infinity;
    return (cache.links || []).filter(link => link.position.start.offset >= start.position.end.offset &&
        link.position.start.offset < boundary).sort((a, b) => a.position.start.offset - b.position.start.offset);
}

function region(value) {
    return REGIONS.includes(value) ? value : undefined;
}

function readVaultGraph(app) {
    const metadata = app.metadataCache;
    const resolvedLinks = metadata.resolvedLinks || {};
    const byPath = new Map();
    const routeCaches = [];
    const short = new Set();
    const routes = [];
    const fixedRegions = new Map();
    const hub = "projects/project-hub.md";
    let hubCache;

    for (const file of app.vault.getMarkdownFiles()) {
        const cache = metadata.getFileCache(file) || {};
        const fm = cache.frontmatter || {};
        const capturedTitle = file.path.startsWith("Notes/ChatGPT memories/") &&
            cache.headings?.find(heading => heading.level === 1)?.heading;
        const title = typeof fm.title === "string" && fm.title.trim() ? fm.title.trim() : capturedTitle || file.basename;
        const tags = [...(cache.tags || []).map(item => item.tag), ...strings(fm.tags).flatMap(tag =>
            tag.split(",").map(part => part.trim()).filter(Boolean).map(part => part.startsWith("#") ? part : "#" + part))];
        const note = { path: file.path, label: title, aliases: strings(fm.aliases ?? fm.alias),
            tags: [...new Set(tags)], headings: (cache.headings || []).map(item => item.heading) };
        byPath.set(file.path, note);
        const routeRegion = region(fm.memory_pathway);
        const folderRegion = /^synthesis\//i.test(file.path) ? "synthesis" : undefined;
        fixedRegions.set(file.path, routeRegion || region(fm.memory_region) || folderRegion);
        if (routeRegion) routeCaches.push({ note, cache, region: routeRegion });
        if (file.path.startsWith("_raw/") || file.path.startsWith("Notes/Inbox/")) short.add(file.path);
        if (file.path === hub) hubCache = cache;
    }

    function destination(link, source) {
        const path = link.link.split("#")[0];
        return path ? byPath.get(metadata.getFirstLinkpathDest(path, source)?.path) : byPath.get(source);
    }

    if (hubCache) {
        for (const link of sectionLinks(hubCache, "Active")) {
            const target = destination(link, hub);
            if (target) short.add(target.path);
        }
    }
    for (const { note, cache, region: routeRegion } of routeCaches) {
        const { path, label } = note;
        const steps = [{ path, label }];
        const links = sectionLinks(cache, "Steps").filter(link => link.original.startsWith("[["));
        let issue = links.length ? "" : "Add a wikilink under the ## Steps heading.";
        for (const link of links) {
            const target = destination(link, path);
            if (target && routeRegion === "short") short.add(target.path);
            // Retain only the verified prefix so a missing step cannot silently create a shortcut.
            if (issue) continue;
            const last = steps[steps.length - 1];
            if (!target) {
                issue = `Cannot resolve the step “${link.link}” to a note.`;
            } else if (last.path === target.path) {
                issue = `“${target.label}” repeats as consecutive steps.`;
            } else if (!resolvedLinks[last.path]?.[target.path] && !resolvedLinks[target.path]?.[last.path]) {
                issue = `No indexed link connects “${last.label}” and “${target.label}”.`;
            } else {
                steps.push({ path: target.path, label: target.label });
            }
        }
        routes.push({ path, label, region: routeRegion, steps, issue });
    }
    const notes = [...byPath.values()];
    for (const note of notes) {
        note.region = fixedRegions.get(note.path) || (short.has(note.path) ? "short" : "long");
    }
    routes.sort((a, b) => REGIONS.indexOf(a.region) - REGIONS.indexOf(b.region) ||
        a.label.localeCompare(b.label) || a.path.localeCompare(b.path));
    return { notes, routes, resolvedLinks };
}

module.exports = { readVaultGraph };

return module.exports; })();

const orb = (() => { const module = { exports: {} };
"use strict";

const PAGE_SIZE = 24;
const EDGE_BUDGET = 2400;
const TAU = 2 * Math.PI;
const MAX_ZOOM = 8;
const BAND = 0.25;
const REGIONS = [
    { id: "short", name: "Working", color: "--orb-working", min: -1, max: -BAND },
    { id: "synthesis", name: "Synthesis", color: "--orb-synthesis", min: -BAND, max: BAND },
    { id: "long", name: "Library", color: "--orb-library", min: BAND, max: 1 }
];
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

// Both anchors are in CSS pixels relative to the center of the viewport.
function anchoredZoom(view, scale, from, to) {
    const zoom = clamp(view.zoom * scale, 1, MAX_ZOOM);
    const ratio = zoom / view.zoom;
    return { zoom, x: to.x - (from.x - view.x) * ratio, y: to.y - (from.y - view.y) * ratio };
}

function activeRegions(query, results, selected, step, readingSearchResult) {
    if (query && !readingSearchResult) return new Set(results.map(node => node.region));
    const focus = selected || step;
    return new Set(focus ? [focus.node.region] : []);
}

// Project the visible boundary of the cap cut by x=±BAND, including its portion of the outer rim.
function projectedCap(r, facing, side) {
    const a = Math.sqrt(Math.max(0, 1 - facing * facing));
    const ring = Math.sqrt(1 - BAND * BAND);
    const seam = new Path2D(), rim = new Path2D();
    if (a <= BAND) {
        if (facing > 0) seam.ellipse(side * r * a * BAND, 0, r * facing * ring, r * ring, 0, 0, TAU);
        return { face: new Path2D(seam), seam, rim };
    }
    const end = Math.acos(clamp(-facing * BAND / (a * ring), -1, 1));
    for (let i = 0; i <= 64; i++) {
        const t = end * (2 * i / 64 - 1);
        const x = side * r * (a * BAND - facing * ring * Math.cos(t));
        const y = side * r * ring * Math.sin(t);
        if (i) seam.lineTo(x, y);
        else seam.moveTo(x, y);
    }
    const rimAngle = Math.acos(BAND / a), offset = side < 0 ? Math.PI : 0;
    const face = new Path2D(seam);
    face.arc(0, 0, r, offset + rimAngle, offset - rimAngle, true);
    face.closePath();
    rim.arc(0, 0, r, offset + rimAngle, offset - rimAngle, true);
    return { face, rim, seam };
}

class Orb {
    constructor(container, { getGraph, openNote, clearSelection }) {
        this.doc = container.ownerDocument;
        this.win = this.doc.defaultView;
        this.getGraph = getGraph;
        this.openNote = openNote;
        this.clearSelection = clearSelection;
        this.events = new this.win.AbortController();
        this.yaw = 0;
        this.pitch = 0.08;
        this.view = { zoom: 1, x: 0, y: 0 };
        this.pointers = new Map();
        this.selectedPath = null;
        this.revealSelection = false;
        this.route = [];
        this.activePath = null;
        this.limit = PAGE_SIZE;
        this.root = this.element("section", container, "memory-orb");
        this.root.setAttribute("aria-label", "Memory orb");
        this.search = this.element("input", this.root, "memory-orb-search");
        this.search.type = "search";
        this.search.placeholder = "Search memories";
        this.search.setAttribute("aria-label", "Search memories");
        this.search.autocomplete = "off";
        this.search.spellcheck = false;
        this.legend = this.element("div", this.root, "memory-orb-legend");
        this.legend.setAttribute("aria-live", "polite");
        this.working = this.element("span", this.legend, "memory-orb-working");
        this.synthesis = this.element("span", this.legend, "memory-orb-synthesis");
        this.library = this.element("span", this.legend, "memory-orb-library");
        this.stage = this.element("div", this.root, "memory-orb-stage");
        this.canvas = this.element("canvas", this.stage);
        this.canvas.tabIndex = 0;
        this.canvas.setAttribute("role", "img");
        this.canvas.setAttribute("aria-label", "Memory orb. Arrow keys rotate, Shift and arrows pan, plus and minus zoom, and zero resets the view.");
        this.ctx = this.canvas.getContext("2d");
        this.tip = this.element("span", this.stage, "memory-orb-tip");
        this.tip.setAttribute("aria-hidden", "true");
        this.controls = this.element("div", this.root, "memory-orb-zoom");
        this.controls.setAttribute("role", "group");
        this.controls.setAttribute("aria-label", "Orb zoom");
        const control = (label, text, action) => {
            const button = this.element("button", this.controls, "", text);
            button.type = "button";
            button.setAttribute("aria-label", label);
            button.title = label;
            this.listen(button, "click", action);
            return button;
        };
        this.zoomOut = control("Zoom out", "−", () => this.zoomBy(1 / 1.5));
        this.zoomOut.disabled = true;
        this.zoomReset = control("Reset orb view", "1×", () => this.resetView());
        this.zoomIn = control("Zoom in", "+", () => this.zoomBy(1.5));
        this.hint = this.element("p", this.root, "memory-orb-hint", "Drag to rotate. Pinch to zoom. Tap a node to read it. Tap it again or tap empty space to clear.");
        this.inspectorMount = this.element("div", this.root, "memory-orb-inspector-mount");
        this.status = this.element("div", this.root, "memory-orb-status");
        this.status.setAttribute("role", "status");
        this.details = this.element("details", this.root, "memory-orb-browser");
        this.summary = this.element("summary", this.details, "", "Browse notes");
        this.list = this.element("div", this.details, "memory-orb-list");
        this.list.setAttribute("role", "list");
        this.more = this.element("button", this.details, "", "Show more notes");
        this.more.type = "button";
        this.listen(this.more, "click", () => {
            this.limit += PAGE_SIZE;
            this.renderList(true);
        });
        this.listen(this.details, "toggle", () => { if (this.details.open) this.renderList(); });
        this.listen(this.search, "input", () => {
            this.win.clearTimeout(this.searchTimer);
            this.searchTimer = this.win.setTimeout(() => this.refresh(), 90);
        });
        this.listen(this.search, "keydown", event => {
            if (event.key === "Escape" && this.search.value) {
                this.search.value = "";
                this.refresh();
            } else if (event.key === "ArrowDown") {
                this.refresh();
                this.details.open = true;
                this.renderList();
                this.list.querySelector("button")?.focus();
                event.preventDefault();
            }
        });
        this.listen(this.list, "click", event => {
            const button = event.target.closest("button[data-path]");
            if (button && this.list.contains(button)) this.toggleNode(button.dataset.path);
        });
        this.listen(this.canvas, "pointerdown", event => this.down(event));
        this.listen(this.canvas, "pointermove", event => this.move(event));
        this.listen(this.canvas, "pointerup", event => this.up(event));
        this.listen(this.canvas, "pointercancel", event => this.endPointer(event));
        this.listen(this.canvas, "lostpointercapture", event => this.endPointer(event));
        this.listen(this.canvas, "pointerleave", () => { if (!this.pointers.size) this.hover(null); });
        this.listen(this.canvas, "wheel", event => {
            if (!event.ctrlKey) return;
            event.preventDefault();
            this.zoomBy(Math.exp(clamp(-event.deltaY * 0.01, -1, 1)), this.anchor(event.clientX, event.clientY));
        });
        this.listen(this.canvas, "keydown", event => {
            const steps = { ArrowLeft: [-0.15, 0], ArrowRight: [0.15, 0], ArrowUp: [0, -0.15], ArrowDown: [0, 0.15] };
            if (["+", "=", "-", "0"].includes(event.key)) {
                event.preventDefault();
                if (event.key === "0") this.resetView();
                else this.zoomBy(event.key === "-" ? 1 / 1.5 : 1.5);
                return;
            }
            if (!steps[event.key]) return;
            event.preventDefault();
            const [dx, dy] = steps[event.key];
            if (event.shiftKey) this.setView({ zoom: this.view.zoom, x: this.view.x + dx * 220, y: this.view.y + dy * 220 });
            else this.rotate(dx, dy);
        });
        this.resize = new this.win.ResizeObserver(() => this.schedule());
        this.resize.observe(this.stage);
        this.theme = new this.win.MutationObserver(() => this.schedule());
        this.theme.observe(this.doc.body, { attributes: true, attributeFilter: ["class", "style"] });
        this.refresh();
    }

    element(tag, parent, className = "", text = "") {
        const element = this.doc.createElement(tag);
        if (className) element.className = className;
        if (text) element.textContent = text;
        parent.appendChild(element);
        return element;
    }

    listen(element, type, handler) {
        element.addEventListener(type, handler, { signal: this.events.signal });
    }

    refresh() {
        if (this.events.signal.aborted) return;
        this.win.clearTimeout(this.searchTimer);
        const query = this.search.value.trim();
        const changed = query !== this.query;
        if (changed) this.readingSearchResult = false;
        this.query = query;
        const graph = this.getGraph(query);
        this.nodes = graph.nodes;
        this.results = query ? this.nodes.filter(node => node.matched !== false) : this.nodes;
        this.edges = graph.edges;
        const groupFor = node => node.region === "short" ? 0 : node.region === "synthesis" ? 1 : 2;
        const counts = [0, 0, 0];
        for (const node of this.nodes) counts[groupFor(node)]++;
        const positions = [0, 0, 0];
        this.points = this.nodes.map(node => {
            const group = groupFor(node);
            const index = positions[group]++;
            const { min, max } = REGIONS[group];
            const x = min + (max - min) * (index + 0.5) / counts[group];
            const width = Math.sqrt(1 - x * x);
            const angle = TAU * ((index * 0.618033988749895 + 0.125) % 1);
            return { node, group, x, y: width * Math.sin(angle), z: width * Math.cos(angle) };
        });
        this.byPath = new Map(this.points.map(p => [p.node.path, p]));
        this.updateSelection();
        this.counts = counts;
        this.updateActivity();
        this.hover(null);
        this.updateRoute();
        const matches = graph.matches ?? this.results.length;
        const count = query ? matches : graph.total;
        const neighbors = this.nodes.length - this.results.length;
        this.status.textContent = query
            ? (count ? count + (count === 1 ? " matching note" : " matching notes") +
                (neighbors ? " · " + neighbors + " linked" : "") : graph.searching ? "" : "No matching notes. Try another search.")
            : (count ? "" : "No memories yet. Add a Markdown note to this vault.");
        this.status.hidden = !this.status.textContent;
        this.hint.hidden = !this.ctx || !this.nodes.length;
        this.stage.hidden = this.hint.hidden;
        this.controls.hidden = this.stage.hidden;
        this.details.hidden = !this.results.length;
        this.summary.textContent = query ? "Matching notes" : "Browse notes";
        if (changed) {
            this.limit = PAGE_SIZE;
            this.details.open = Boolean(query) || !this.ctx;
        }
        if (this.details.open) this.renderList();
        else this.list.replaceChildren();
        this.schedule();
    }

    renderList(focusFirstNew = false) {
        const priorCount = this.list.childElementCount;
        const focusedPath = this.doc.activeElement?.dataset?.path;
        this.list.replaceChildren();
        for (const node of this.results.slice(0, this.limit)) {
            const row = this.element("div", this.list);
            row.setAttribute("role", "listitem");
            const button = this.element("button", row);
            button.type = "button";
            button.dataset.path = node.path;
            if (node.path === this.selectedPath) button.setAttribute("aria-current", "true");
            this.element("span", button, "", node.label);
            const folder = node.path.split("/").slice(0, -1).join("/");
            if (folder) this.element("small", button, "", folder);
            if (node.path === focusedPath) button.focus({ preventScroll: true });
        }
        this.more.hidden = this.results.length <= this.limit;
        if (focusFirstNew) this.list.children[priorCount]?.querySelector("button")?.focus();
    }

    setSelection(path, { reveal = true } = {}) {
        const next = path || null;
        const changed = next !== this.selectedPath;
        const outsideFilter = reveal && next && this.query && !this.byPath.has(next);
        if (reveal || !next) {
            this.readingSearchResult = Boolean(next && reveal);
            if (this.byPath) this.updateActivity(next);
        }
        if (!changed && !outsideFilter) return;
        this.selectedPath = next;
        this.revealSelection = Boolean(next && reveal);
        if (outsideFilter) {
            this.search.value = "";
            this.refresh();
        } else {
            this.updateSelection();
            this.updateActivity();
            for (const button of this.list.querySelectorAll("button")) {
                if (button.dataset.path === next) button.setAttribute("aria-current", "true");
                else button.removeAttribute("aria-current");
            }
            this.schedule();
        }
    }

    toggleNode(path, options) {
        if (path === this.selectedPath) this.clearSelection();
        else this.openNote(path, options);
    }

    updateSelection() {
        this.neighbors = new Set();
        const path = this.selectedPath;
        if (!path || !this.byPath.has(path)) return;
        for (const [a, b] of this.edges) {
            const other = a === path ? b : b === path ? a : null;
            if (other && other !== path && this.byPath.has(other)) this.neighbors.add(other);
        }
    }

    setPathway(paths, activePath, { clearSearch = false } = {}) {
        this.route = Array.from(paths || []);
        this.activePath = activePath || null;
        this.updateActivity();
        if (clearSearch && this.search.value) {
            this.search.value = "";
            this.refresh();
        } else {
            this.updateRoute();
            this.schedule();
        }
    }

    updateRoute() {
        this.members = new Set(this.route);
        const key = (a, b) => a < b ? a + "\0" + b : b + "\0" + a;
        const wanted = new Set(this.route.slice(1).map((path, index) => key(path, this.route[index])));
        this.routeEdges = [];
        if (!wanted.size) return;
        for (const [a, b] of this.edges) {
            if (wanted.delete(key(a, b)) && this.byPath.has(a) && this.byPath.has(b)) {
                this.routeEdges.push([this.byPath.get(a), this.byPath.get(b)]);
            }
        }
    }

    updateActivity(selectedPath = this.selectedPath) {
        const regions = activeRegions(this.query, this.results, this.byPath.get(selectedPath),
            this.byPath.get(this.activePath), this.readingSearchResult);
        this.activeRegions = regions;
        const chips = [this.working, this.synthesis, this.library];
        for (const [i, { id, name }] of REGIONS.entries()) {
            const chip = chips[i], active = regions.has(id);
            chip.classList.toggle("is-active", active);
            const label = name + " · " + this.counts[i] + (active ? " · active" : "");
            if (chip.textContent !== label) chip.textContent = label;
        }
        this.schedule();
    }

    rotate(dx, dy) {
        this.yaw = (this.yaw + dx) % TAU;
        this.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.pitch + dy));
        this.hover(null);
        this.schedule();
    }

    anchor(x, y) {
        const rect = this.canvas.getBoundingClientRect();
        return { x: x - rect.left - rect.width / 2, y: y - rect.top - rect.height / 2 };
    }

    setView(view) {
        const radius = Math.min(this.stage.clientWidth, this.stage.clientHeight) * 0.43 * view.zoom;
        // Leave part of the sphere within reach even after a long pan.
        const limitX = radius + this.stage.clientWidth * 0.3;
        const limitY = radius + this.stage.clientHeight * 0.3;
        this.view = { zoom: view.zoom, x: clamp(view.x, -limitX, limitX), y: clamp(view.y, -limitY, limitY) };
        this.zoomOut.disabled = view.zoom <= 1;
        this.zoomIn.disabled = view.zoom >= MAX_ZOOM;
        const currentZoom = Number(view.zoom.toFixed(1)) + "×";
        if (this.zoomReset.textContent !== currentZoom) {
            this.zoomReset.textContent = currentZoom;
            this.zoomReset.setAttribute("aria-label", "Reset orb view, current zoom " + currentZoom);
        }
        this.hover(null);
        this.schedule();
    }

    zoomBy(factor, anchor = { x: 0, y: 0 }) {
        this.setView(anchoredZoom(this.view, factor, anchor, anchor));
    }

    resetView() {
        this.yaw = 0;
        this.pitch = 0.08;
        this.setView({ zoom: 1, x: 0, y: 0 });
    }

    hit(event) {
        const rect = this.canvas.getBoundingClientRect();
        const x = event.clientX - rect.left, y = event.clientY - rect.top;
        let nearest = null, best = (event.pointerType === "touch" ? 17 : 10) ** 2;
        for (const p of this.points) {
            const score = (p.px - x) ** 2 + (p.py - y) ** 2 + (1 - p.depth) * 3;
            if (score < best) { best = score; nearest = p; }
        }
        return nearest;
    }

    hover(p) {
        if (this.hovered === p) return;
        this.hovered = p;
        this.tip.textContent = p?.node.label || "";
        this.canvas.style.cursor = p ? "pointer" : "grab";
        this.schedule();
    }

    down(event) {
        if (event.button !== 0 || this.pointers.has(event.pointerId)) return;
        // Obsidian interprets rapid canvas gestures as a request to edit the containing note.
        event.stopPropagation();
        this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, dragged: false });
        this.canvas.setPointerCapture(event.pointerId);
        if (this.pointers.size >= 2) {
            for (const p of this.pointers.values()) p.multi = true;
            this.beginPinch();
        }
    }

    pinchGeometry() {
        const [a, b] = this.pointers.values();
        return { anchor: this.anchor((a.x + b.x) / 2, (a.y + b.y) / 2), distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) };
    }

    beginPinch() {
        this.pinch = this.pointers.size >= 2 ? { ...this.pinchGeometry(), view: this.view } : null;
    }

    move(event) {
        const p = this.pointers.get(event.pointerId);
        if (!p) { if (event.pointerType !== "touch") this.hover(this.hit(event)); return; }
        const dx = event.clientX - p.x, dy = event.clientY - p.y;
        if (!p.multi && !p.dragged && Math.hypot(event.clientX - p.startX, event.clientY - p.startY) < 5) return;
        p.x = event.clientX;
        p.y = event.clientY;
        if (this.pinch) {
            const { anchor, distance } = this.pinchGeometry();
            this.setView(anchoredZoom(this.pinch.view, distance / this.pinch.distance, this.pinch.anchor, anchor));
        } else if (!p.multi) {
            p.dragged = true;
            const scale = 2.7 / (Math.max(80, this.canvas.clientWidth) * this.view.zoom);
            this.rotate(dx * scale, dy * scale);
        }
        this.canvas.style.cursor = "grabbing";
    }

    endPointer(event) {
        if (!this.pointers.delete(event.pointerId)) return;
        this.beginPinch();
        this.canvas.style.cursor = this.pointers.size ? "grabbing" : "grab";
    }

    up(event) {
        const p = this.pointers.get(event.pointerId);
        if (!p) return;
        this.endPointer(event);
        if (!p.multi && !p.dragged && Math.hypot(event.clientX - p.startX, event.clientY - p.startY) < 5) {
            const hit = this.hit(event);
            if (hit) this.toggleNode(hit.node.path, { scrollReader: false });
            else if (this.selectedPath) this.clearSelection();
        }
    }

    schedule() {
        if (this.frame || this.events.signal.aborted) return;
        this.frame = this.win.requestAnimationFrame(() => {
            this.frame = 0;
            this.draw();
        });
    }

    drawRegions(cx, cy, r, colors, ink, ca, sa, cb, sb) {
        const ctx = this.ctx;
        const nz = -sa * cb;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(Math.atan2(-sa * sb, ca));
        const left = projectedCap(r, -nz, -1), right = projectedCap(r, nz, 1);
        const band = new Path2D();
        band.arc(0, 0, r, 0, TAU);
        const outer = new Path2D(band);
        band.addPath(left.face);
        band.addPath(right.face);
        const masks = [left.face, band, right.face];
        for (const [group, face] of masks.entries()) {
            const active = this.activeRegions.has(REGIONS[group].id);
            ctx.save();
            ctx.clip(face, "evenodd");
            ctx.fillStyle = colors[group]; ctx.globalAlpha = active ? 0.18 : 0.06;
            ctx.fillRect(-r, -r, 2 * r, 2 * r);
            if (active) {
                const x = (group - 1) * r * 0.60 * Math.hypot(ca, sa * sb);
                const light = ctx.createRadialGradient(x, 0, 0, x, 0, r * 1.35);
                light.addColorStop(0, colors[group]); light.addColorStop(1, "transparent");
                ctx.fillStyle = light; ctx.globalAlpha = 0.36; ctx.fillRect(-r, -r, 2 * r, 2 * r);
            }
            ctx.restore();
        }
        for (const [group, rim] of [[1, outer], [0, left.rim], [2, right.rim]]) {
            const active = this.activeRegions.has(REGIONS[group].id);
            ctx.strokeStyle = colors[group]; ctx.globalAlpha = active ? 1 : 0.77;
            ctx.lineWidth = active ? 2.6 : 1.7; ctx.stroke(rim);
        }
        const boundaries = new Path2D(left.seam);
        boundaries.addPath(right.seam);
        ctx.strokeStyle = this.win.getComputedStyle(this.root).getPropertyValue("--background-primary").trim() || "#111";
        ctx.globalAlpha = 0.90; ctx.lineWidth = 4; ctx.stroke(boundaries);
        ctx.strokeStyle = ink; ctx.globalAlpha = 0.83; ctx.lineWidth = 1.5; ctx.stroke(boundaries);
        ctx.restore();
    }

    draw() {
        if (!this.ctx || this.stage.hidden) return;
        const w = this.stage.clientWidth, h = this.stage.clientHeight;
        if (!w || !h) return;
        const ratio = Math.min(this.win.devicePixelRatio || 1, 2);
        const ctx = this.ctx;
        if (this.canvas.width !== Math.round(w * ratio)) this.canvas.width = Math.round(w * ratio);
        if (this.canvas.height !== Math.round(h * ratio)) this.canvas.height = Math.round(h * ratio);
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        ctx.clearRect(0, 0, w, h);
        const style = this.win.getComputedStyle(this.root);
        const colors = REGIONS.map(region => style.getPropertyValue(region.color).trim());
        const ink = style.color;
        const zoom = this.view.zoom;
        const baseRadius = Math.min(w, h) * 0.43;
        const r = baseRadius * zoom;
        let cx = w / 2 + this.view.x, cy = h / 2 + this.view.y;
        const ca = Math.cos(this.yaw), sa = Math.sin(this.yaw), cb = Math.cos(this.pitch), sb = Math.sin(this.pitch);
        const selected = this.byPath.get(this.selectedPath);
        if (this.revealSelection && selected) {
            this.revealSelection = false;
            const z = selected.z * ca - selected.x * sa;
            const x = (selected.x * ca + selected.z * sa) * r;
            const y = -(selected.y * cb - z * sb) * r;
            if (zoom > 1 && (cx + x < 16 || cx + x > w - 16 || cy + y < 16 || cy + y > h - 16)) {
                this.view = { zoom, x: -x, y: -y };
                cx = w / 2 - x;
                cy = h / 2 - y;
            }
        }
        const buckets = Array.from({ length: 30 }, () => []);
        for (const p of this.points) {
            const z = p.z * ca - p.x * sa;
            p.depth = z * cb + p.y * sb;
            p.px = cx + (p.x * ca + p.z * sa) * r;
            p.py = cy - (p.y * cb - z * sb) * r;
            if (p.px < -10 || p.px > w + 10 || p.py < -10 || p.py > h + 10) continue;
            const bucket = Math.min(4, Math.max(0, Math.floor((p.depth + 1) * 2.5)));
            const linkedOnly = this.query && p.node.matched === false;
            buckets[(linkedOnly ? 0 : 15) + bucket * 3 + p.group].push(p);
        }
        const shade = ctx.createRadialGradient(cx - r * 0.34, cy - r * 0.34, 0, cx, cy, r);
        shade.addColorStop(0, colors[0]);
        shade.addColorStop(0.72, "transparent");
        shade.addColorStop(1, colors[2]);
        ctx.globalAlpha = 0.10;
        ctx.fillStyle = shade;
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.fill();
        ctx.strokeStyle = ink; ctx.lineWidth = 0.8; ctx.stroke();
        this.drawRegions(cx, cy, r, colors, ink, ca, sa, cb, sb);
        ctx.globalAlpha = this.members.size || selected ? 0.075 : Math.min(0.34, 0.16 + (zoom - 1) * 0.055);
        ctx.strokeStyle = ink; ctx.lineWidth = Math.min(1.4, 0.65 * Math.sqrt(zoom));
        ctx.beginPath();
        // Sample dense edge sets during drawing; all pathway edges still render in full.
        const stride = Math.max(1, Math.ceil(this.edges.length / (EDGE_BUDGET * Math.min(zoom, 3))));
        for (let i = 0; i < this.edges.length; i += stride) {
            const edge = this.edges[i];
            const a = this.byPath.get(edge[0]), b = this.byPath.get(edge[1]);
            if (!a || !b || Math.max(a.px, b.px) < 0 || Math.min(a.px, b.px) > w ||
                Math.max(a.py, b.py) < 0 || Math.min(a.py, b.py) > h) continue;
            ctx.moveTo(a.px, a.py); ctx.lineTo(b.px, b.py);
        }
        ctx.stroke();
        if (selected) {
            ctx.globalAlpha = 0.82;
            ctx.strokeStyle = colors[selected.group];
            ctx.lineWidth = 1.7;
            ctx.setLineDash([4, 3]);
            ctx.beginPath();
            for (const path of this.neighbors) {
                const p = this.byPath.get(path);
                ctx.moveTo(selected.px, selected.py); ctx.lineTo(p.px, p.py);
            }
            ctx.stroke();
            ctx.setLineDash([]);
        }
        const density = clamp(baseRadius / Math.sqrt(this.points.length + 1) * 0.45, 1.3, 3.2) * Math.sqrt(zoom);
        buckets.forEach((bucket, index) => {
            const linkedOnly = index < 15;
            const depth = Math.floor(index % 15 / 3) / 4;
            const size = density * (0.60 + 0.65 * depth) * (linkedOnly ? 0.72 : 1);
            ctx.fillStyle = colors[index % 3];
            ctx.globalAlpha = (0.25 + 0.75 * depth) * (linkedOnly ? 0.40 : 1);
            if (this.activeRegions.size && !this.activeRegions.has(REGIONS[index % 3].id))
                ctx.globalAlpha *= 0.65;
            ctx.beginPath();
            for (const p of bucket) {
                ctx.moveTo(p.px + size, p.py);
                ctx.arc(p.px, p.py, size, 0, TAU);
            }
            ctx.fill();
        });
        ctx.globalAlpha = 1; ctx.strokeStyle = ink; ctx.lineWidth = 2.4;
        ctx.beginPath();
        for (const [a, b] of this.routeEdges) { ctx.moveTo(a.px, a.py); ctx.lineTo(b.px, b.py); }
        ctx.stroke();
        for (const path of this.members) {
            const p = this.byPath.get(path);
            if (!p) continue;
            ctx.fillStyle = colors[p.group];
            ctx.beginPath(); ctx.arc(p.px, p.py, 4.7, 0, TAU); ctx.fill(); ctx.stroke();
        }
        for (const p of [this.byPath.get(this.activePath), this.hovered]) {
            if (!p) continue;
            ctx.beginPath(); ctx.arc(p.px, p.py, 9, 0, TAU); ctx.stroke();
        }
        if (selected) {
            ctx.strokeStyle = colors[selected.group];
            ctx.lineWidth = 2.4;
            ctx.beginPath(); ctx.arc(selected.px, selected.py, 11, 0, TAU); ctx.stroke();
        }
        if (zoom >= 1.45 || selected) this.drawLabels(w, h, style, selected);
    }

    drawLabels(w, h, style, selected) {
        const ctx = this.ctx, zoom = this.view.zoom;
        const limit = Math.min(24, Math.floor((zoom - 1) * 4) + 1);
        const candidates = this.points.filter(p => p.px >= 0 && p.px <= w && p.py >= 0 && p.py <= h &&
            (p === selected || (zoom >= 1.45 && (p.depth >= 0 || this.neighbors.has(p.node.path)))));
        const priority = p => p === selected ? -4 : this.neighbors.has(p.node.path) ? -2 :
            Math.hypot((p.px - w / 2) / w, (p.py - h / 2) / h) - p.depth * 0.2;
        candidates.sort((a, b) => priority(a) - priority(b));
        ctx.font = "12px " + (style.fontFamily || "sans-serif");
        ctx.textBaseline = "middle";
        ctx.fillStyle = style.color;
        ctx.strokeStyle = style.getPropertyValue("--background-primary").trim() || "#101716";
        ctx.lineWidth = 3.4;
        ctx.lineJoin = "round";
        const used = [];
        for (const p of candidates) {
            const raw = p.node.label;
            const text = raw.length > 30 ? raw.slice(0, 29) + "…" : raw;
            const width = Math.min(w - 8, ctx.measureText(text).width);
            const left = clamp(p.px + width + 13 < w ? p.px + 12 : p.px - width - 12, 4, w - width - 4);
            const y = clamp(p.py, 10, h - 10), right = left + width;
            if (used.some(b => left < b.right + 5 && right > b.left - 5 && Math.abs(y - b.y) < 17)) continue;
            ctx.strokeText(text, left, y, width);
            ctx.fillText(text, left, y, width);
            used.push({ left, right, y });
            if (used.length >= limit) break;
        }
    }

    destroy() {
        this.events.abort();
        this.pointers.clear();
        this.pinch = null;
        this.resize.disconnect();
        this.theme.disconnect();
        this.win.clearTimeout(this.searchTimer);
        this.win.cancelAnimationFrame(this.frame);
        this.root.remove();
    }
}

module.exports = { Orb, activeRegions };

return module.exports; })();

const search = (() => { const module = { exports: {} };
"use strict";

// Add a single hop through real note links. Only direct text matches go in the result list.
function neighborhood(graph, hits) {
    const visible = new Set(hits);
    for (const [from, to] of graph.edges) {
        if (hits.has(from)) visible.add(to);
        if (hits.has(to)) visible.add(from);
    }
    return {
        nodes: graph.nodes.filter(n => visible.has(n.path)).map(n => ({ ...n, matched: hits.has(n.path) })),
        edges: graph.edges.filter(([a, b]) => visible.has(a) && visible.has(b)),
        total: graph.total, matches: hits.size
    };
}

module.exports = { neighborhood };

return module.exports; })();

const inspector = (() => { const module = { exports: {} };
"use strict";

class Inspector {
    constructor(container, actions) {
        this.actions = actions;
        this.doc = container.ownerDocument;
        this.rev = 0;
        this.root = this.add(container, "section", "memory-orb-inspector");
        this.root.hidden = true;
        this.root.setAttribute("aria-label", "Open memory");
        const header = this.add(this.root, "div", "memory-orb-inspector-header");
        this.title = this.add(header, "h3");
        this.back = this.button(header, "Back", () => actions.goBack());
        this.button(header, "Close", () => actions.close());
        this.status = this.add(this.root, "div", "memory-orb-inspector-status");
        this.status.setAttribute("role", "status");
        this.reader = this.add(this.root, "div", "memory-orb-inspector-reader");
        this.reader.tabIndex = 0;
        this.reader.setAttribute("role", "region");
        this.reader.setAttribute("aria-label", "Note content");
        this.properties = this.add(this.reader, "details");
        this.add(this.properties, "summary").textContent = "Properties";
        this.yaml = this.add(this.properties, "pre");
        this.text = this.add(this.reader, "div", "memory-orb-inspector-text");
        this.related = this.add(this.root, "details", "memory-orb-inspector-links");
        this.linkCount = this.add(this.related, "summary");
        this.links = this.add(this.related, "div");
    }

    add(parent, tag, className = "") {
        const el = this.doc.createElement(tag);
        if (className) el.className = className;
        parent.appendChild(el);
        return el;
    }

    button(parent, label, action) {
        const el = this.add(parent, "button");
        el.type = "button";
        el.textContent = label;
        el.addEventListener("click", action);
        return el;
    }

    async show(path, canGoBack, { reload = true, reveal = true } = {}) {
        const info = this.actions.getFileInfo(path);
        const changed = path !== this.path || !info;
        this.root.hidden = false;
        this.back.disabled = !canGoBack;
        this.title.textContent = info?.label || "Memory unavailable";
        if (changed) {
            this.resetContent();
            this.path = path;
        }
        if (!info) {
            ++this.rev;
            this.path = undefined;
            this.status.textContent = "This note moved or was removed.";
            return;
        }
        const changedLinks = this.updateLinks(info.neighbors);
        if (changed && reveal) {
            const rect = this.title.getBoundingClientRect();
            if (rect.top < 0 || rect.bottom > this.doc.defaultView.innerHeight)
                this.title.scrollIntoView({ block: "nearest" });
        }
        if (!changed && !reload && !this.failed) {
            if (changedLinks && this.raw?.includes("[[")) this.renderText(this.raw, path);
            return;
        }
        this.failed = false;
        const rev = ++this.rev;
        this.reader.setAttribute("aria-busy", "true");
        if (changed) this.status.textContent = "Opening note…";
        try {
            const body = await this.actions.readNote(path);
            if (rev !== this.rev) return;
            if (typeof body !== "string") throw new TypeError("Missing note body");
            // Keep Markdown, code fences, and embeds inert. Only the leading YAML section is folded.
            const opening = body.match(/^\uFEFF?---[ \t]*\r?\n/);
            let props = "";
            if (opening) {
                const delimiter = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/gm;
                delimiter.lastIndex = opening[0].length;
                if (delimiter.exec(body)) props = body.slice(0, delimiter.lastIndex);
            }
            this.properties.hidden = !props;
            if (this.yaml.textContent !== props) this.yaml.textContent = props;
            this.raw = body.slice(props.length);
            this.renderText(this.raw, path);
            this.status.textContent = body.length ? "" : "This note is empty.";
        } catch {
            if (rev !== this.rev) return;
            this.failed = true;
            this.raw = undefined;
            this.properties.hidden = true;
            this.yaml.textContent = "";
            this.text.textContent = "";
            this.status.textContent = "Could not read this note on this device.";
        }
        this.reader.setAttribute("aria-busy", "false");
    }

    renderText(raw, path) {
        const resolve = this.actions.resolveLink;
        if (!resolve || !raw.includes("[[")) {
            if (this.text.childElementCount || this.text.textContent !== raw) this.text.textContent = raw;
            return;
        }
        const fragment = this.doc.createDocumentFragment();
        const tokens = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)|(`+)|\n|(!?)\[\[([^\[\]\r\n]+)\]\]/gm;
        let last = 0, fence = "", inlineCode = "";
        for (const match of raw.matchAll(tokens)) {
            const [token, marker, tail, ticks, embed, wiki] = match;
            if (marker) {
                if (!fence) fence = marker;
                else if (marker.startsWith(fence) && !tail.trim()) fence = "";
                continue;
            }
            if (fence) continue;
            if (token === "\n") { inlineCode = ""; continue; }
            if (ticks) {
                if (!inlineCode) inlineCode = ticks;
                else if (inlineCode === ticks) inlineCode = "";
                continue;
            }
            if (inlineCode || embed || raw[match.index - 1] === "\\") continue;
            const bar = wiki.indexOf("|");
            const target = (bar < 0 ? wiki : wiki.slice(0, bar).replace(/\\$/, "")).trim();
            if (!target || target.startsWith("#")) continue;
            let result;
            try { result = resolve(target, path); } catch { continue; }
            const dest = typeof result === "string" ? result : result?.path;
            if (!dest) continue;
            fragment.append(raw.slice(last, match.index));
            const label = bar < 0 ? target : wiki.slice(bar + 1).trim() || target;
            const button = this.button(fragment, label, () => this.actions.openPath(dest));
            button.className = "memory-orb-inline-link";
            button.title = dest;
            last = match.index + token.length;
        }
        fragment.append(raw.slice(last));
        this.text.replaceChildren(fragment);
    }

    updateLinks(neighbors) {
        if (this.neighbors?.length === neighbors.length && neighbors.every((note, i) =>
            note.path === this.neighbors[i].path && note.label === this.neighbors[i].label)) return false;
        this.neighbors = neighbors;
        this.related.hidden = !neighbors.length;
        this.linkCount.textContent = "Connected notes (" + neighbors.length + ")";
        const focusPath = this.doc.activeElement?.dataset?.neighbor;
        this.links.replaceChildren();
        const labels = new Set(), repeated = new Set();
        for (const { label } of neighbors) {
            if (labels.has(label)) repeated.add(label);
            labels.add(label);
        }
        for (const { path, label } of neighbors) {
            const text = repeated.has(label) ? label + " · " + path : label;
            const button = this.button(this.links, text, () => this.actions.openPath(path));
            button.dataset.neighbor = path;
            button.title = path;
            if (path === focusPath) button.focus({ preventScroll: true });
        }
        return true;
    }

    resetContent() {
        this.reader.scrollTop = 0;
        this.raw = undefined;
        this.neighbors = undefined;
        this.reader.setAttribute("aria-busy", "false");
        this.properties.open = false;
        this.properties.hidden = true;
        this.related.open = false;
        this.related.hidden = true;
        this.yaml.textContent = "";
        this.text.textContent = "";
        this.status.textContent = "";
        this.links.replaceChildren();
    }

    clear() {
        ++this.rev;
        this.path = undefined;
        this.root.hidden = true;
        this.title.textContent = "";
        this.resetContent();
    }

    destroy() {
        this.clear();
        this.root.remove();
    }
}

module.exports = { Inspector };

return module.exports; })();

const capture = (() => { const module = { exports: {} };
"use strict";

const DEST = "Notes/ChatGPT memories";
const PASTE_HELP = "Copy the words you want to keep from ChatGPT and paste them here.";
const REGION_NAMES = new Map([["short", "Working"], ["long", "Library"], ["synthesis", "Synthesis"]]);

function captureText(value) {
    if (typeof value !== "string" || !value.trim()) throw new Error(PASTE_HELP);
    if (value.includes("\0")) throw new Error("The selection contains a null character. Paste plain text.");
    const text = value.replace(/\r\n?/g, "\n").replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, "");
    const remainder = text
        .replace(/\[[^\]\n]*\]\(<?(?:https?:\/\/|obsidian:\/\/)[^\s>]+>?\)/gi, "")
        .replace(/(?:[a-z][\w+.-]*:\/\/|www\.|(?:chatgpt\.com|chat\.openai\.com)\/share\/)[^\s<>]+/gi, "");
    if (remainder !== text && !remainder.replace(/[\s<>.,;:!?*()[\]—–-]/g, "")) {
        throw new Error("A link only points to the conversation. " + PASTE_HELP);
    }
    return text;
}

function cleanTitle(title, text) {
    const source = typeof title === "string" && title.trim() ? title : text.split("\n", 1)[0];
    const plain = source.normalize("NFC").replace(/[\p{Cc}\p{Cf}\[\]<>]/gu, " ").replace(/\s+/gu, " ").trim();
    return Array.from(plain).slice(0, 100).join("").trim() || "ChatGPT memory";
}

function relatedLink(vault, path) {
    if (!path) return "";
    const parts = typeof path === "string" ? path.split("/") : [];
    const file = parts.length && parts.every(part => part && part !== "." && part !== ".." && !part.startsWith(".")) &&
        !/[\\\r\n\0]/.test(path) && vault.getAbstractFileByPath(path);
    if (!file || file.path !== path || file.extension?.toLowerCase() !== "md") {
        throw new Error("The related note is unavailable. Clear the connection to save without it.");
    }
    if (!/[\[\]|#^<>]/.test(path)) return "[[" + path.replace(/\.md$/i, "") + "]]";
    // Link unusual filenames without letting their punctuation change the Markdown.
    const encoded = parts.map(part => encodeURIComponent(part).replace(/[!'()*]/g, c =>
        "%" + c.charCodeAt(0).toString(16))).join("/");
    return "[Related note](<" + "../".repeat(DEST.split("/").length) + encoded + ">)";
}

async function createCapture(vault, { title, text: raw, region = "long", relatedPath }) {
    const text = captureText(raw);
    if (!REGION_NAMES.has(region)) throw new Error("Choose Working, Library, or Synthesis.");
    const link = relatedLink(vault, relatedPath);
    const label = cleanTitle(title, text);
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    const id = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
    const suffix = " - " + id.slice(0, 20) + ".md";
    const marker = "chatgpt_capture_id: " + id;
    const slug = Array.from(label.replace(/[^\p{L}\p{M}\p{N} _-]+/gu, " ").replace(/\s+/gu, " ").trim())
        .slice(0, 42).join("").trim() || "ChatGPT memory";
    const target = DEST + "/" + slug + suffix;
    for (const path of ["Notes", DEST]) {
        if (!vault.getAbstractFileByPath(path)) {
            try { await vault.createFolder(path); }
            catch (error) { if (!vault.getAbstractFileByPath(path)) throw error; }
        }
        if (!Array.isArray(vault.getAbstractFileByPath(path)?.children)) throw new Error("The capture folder is blocked by an existing file.");
    }
    const folder = vault.getAbstractFileByPath(DEST);
    async function existing(file) {
        if (file?.extension !== "md") return null;
        const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(await vault.cachedRead(file));
        return frontmatter?.[1].split(/\r?\n/).includes(marker) ? { file, created: false } : null;
    }
    for (const file of folder.children) {
        if (file.path.endsWith(suffix)) {
            const prior = await existing(file);
            if (prior) return prior;
        }
    }
    // A longer fence than any in the selection makes pasted Markdown inert.
    let longest = 2;
    for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
    const fence = "`".repeat(longest + 1);
    const body = ["---", "title: " + JSON.stringify(label), "source: ChatGPT", "memory_region: " + region,
        marker, "---", "", fence + "text", text, fence, "", ...(link ? ["Related memory · " + link, ""] : [])].join("\n");
    try { return { file: await vault.create(target, body), created: true }; }
    catch (error) {
        const prior = await existing(vault.getAbstractFileByPath(target));
        if (prior) return prior;
        throw error;
    }
}

function captureWriter(vault) {
    // Serialize reviews so two open actions cannot create duplicate notes under different titles.
    let queue = Promise.resolve();
    return draft => {
        const write = queue.then(() => createCapture(vault, draft));
        queue = write.catch(() => {});
        return write;
    };
}

function registerCapture(plugin) {
    const { Modal, Notice } = require("obsidian");
    const save = captureWriter(plugin.app.vault);
    let active;
    class CaptureModal extends Modal {
        constructor(draft) {
            super(plugin.app);
            this.draft = draft;
        }
        onOpen() {
            this.titleEl.textContent = "Capture from ChatGPT";
            const root = this.contentEl;
            const doc = root.ownerDocument;
            const destination = doc.createElement("p");
            destination.textContent = "Save to " + plugin.app.vault.getName() + " / " + DEST;
            root.append(destination);
            const field = (label, tag) => {
                const wrapper = doc.createElement("label");
                wrapper.style.display = "block";
                wrapper.style.marginBottom = "0.75em";
                wrapper.textContent = label;
                const element = doc.createElement(tag);
                element.style.display = "block";
                element.style.width = "100%";
                wrapper.append(element);
                root.append(wrapper);
                return element;
            };
            const title = field("Title", "input");
            title.type = "text";
            title.maxLength = 100;
            title.placeholder = "A name you’ll recognize";
            title.value = this.draft.title || "";
            const text = field("Selected ChatGPT text", "textarea");
            text.rows = 7;
            text.placeholder = PASTE_HELP;
            text.value = this.draft.text || "";
            const region = field("Memory region", "select");
            for (const [value, name] of REGION_NAMES) {
                const option = doc.createElement("option");
                option.value = value; option.textContent = name; region.append(option);
            }
            region.value = "long";
            const related = this.draft.relatedPath;
            let connect;
            if (related) {
                const label = doc.createElement("label");
                connect = doc.createElement("input");
                connect.type = "checkbox"; connect.checked = true;
                label.append(connect, " Connect to " + related);
                root.append(label);
            }
            const status = doc.createElement("p");
            status.setAttribute("role", "status");
            if (text.value) {
                try { captureText(text.value); } catch (error) { status.textContent = error.message; }
            }
            const button = doc.createElement("button");
            button.type = "button";
            button.className = "mod-cta";
            button.textContent = "Save memory";
            const cancel = doc.createElement("button");
            cancel.type = "button"; cancel.textContent = "Cancel";
            cancel.addEventListener("click", () => this.close());
            root.append(status, button, doc.createTextNode(" "), cancel);
            button.addEventListener("click", async () => {
                if (button.disabled) return;
                const fields = [button, cancel, title, text, region, ...(connect ? [connect] : [])];
                for (const input of fields) input.disabled = true;
                status.textContent = "Saving…";
                try {
                    const result = await save({ title: title.value, text: text.value, region: region.value,
                        relatedPath: connect?.checked ? related : null });
                    new Notice(result.created ? "Saved to " + result.file.path : "Already saved as " + result.file.path);
                    this.close();
                } catch (error) {
                    status.textContent = error.message || "Save failed. Your draft is still here.";
                    for (const input of fields) input.disabled = false;
                }
            });
        }
        onClose() {
            this.contentEl.replaceChildren();
            if (active === this) active = null;
        }
    }
    const open = draft => {
        if (active) { new Notice("Finish the open memory capture first."); return; }
        active = new CaptureModal(draft);
        active.open();
    };
    const openCapture = relatedPath => open({ relatedPath });
    plugin.registerObsidianProtocolHandler("memory-orb-capture", args =>
        open({ title: typeof args.title === "string" ? args.title : "", text: typeof args.text === "string" ? args.text : "" }));
    plugin.addCommand({ id: "capture-chatgpt-memory", name: "Capture from ChatGPT", callback: () => openCapture() });
    plugin.register(() => active?.close());
    return openCapture;
}

module.exports = { registerCapture, captureWriter };

return module.exports; })();
"use strict";

const { Plugin, MarkdownRenderChild, Notice } = require("obsidian");
const { buildGraph } = graph;
const { readVaultGraph } = pathways;
const { Orb } = orb;
const { Inspector } = inspector;
const { registerCapture } = capture;
const { neighborhood } = search;

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
