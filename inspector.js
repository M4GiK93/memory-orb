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
