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
