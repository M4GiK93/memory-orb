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
