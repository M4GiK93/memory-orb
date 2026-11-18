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
