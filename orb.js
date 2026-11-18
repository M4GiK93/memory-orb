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
    constructor(container, { getGraph, openNote }) {
        this.doc = container.ownerDocument;
        this.win = this.doc.defaultView;
        this.getGraph = getGraph;
        this.openNote = openNote;
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
        this.hint = this.element("p", this.root, "memory-orb-hint", "Drag to rotate. Pinch to zoom. Tap a node to explore.");
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
            if (button && this.list.contains(button)) this.openNote(button.dataset.path);
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
            if (hit) this.openNote(hit.node.path);
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
