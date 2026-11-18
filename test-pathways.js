"use strict";

const assert = require("node:assert/strict");
const { readVaultGraph } = require("./pathways");

const position = offset => ({ start: { offset }, end: { offset: offset + 1 } });
const heading = (heading, offset, level = 2) => ({ heading, level, position: position(offset) });
const wiki = (link, offset) => ({ link, original: `[[${link}]]`, position: position(offset) });
const route = (region, links) => ({ frontmatter: { memory_pathway: region },
    headings: [heading("Steps", 10), heading("Subsection", 22, 3), heading("Related", 70)], links });
const shortPath = "Routes/Resume.md";
const longPath = "Routes/Reference.md";
const synthesisPath = "Routes/Combine.md";
const hub = "projects/project-hub.md";
const cache = {
    [shortPath]: route("short", [wiki("Stray", 5), wiki("A#Heading", 18), wiki("B", 24), wiki("C", 30),
        { link: "Stray", original: "[reference](Stray.md)", position: position(49) }, wiki("Stray", 80)]),
    [longPath]: route("long", [wiki("B", 15)]),
    [synthesisPath]: route("synthesis", [wiki("A", 14), wiki("B", 15), wiki("Source", 16)]),
    "Routes/Broken synthesis.md": route("synthesis", [wiki("A", 15), wiki("Unlinked", 16)]),
    "Routes/Closed.md": route("short", [wiki("Deleted", 12), wiki("C", 15)]),
    "Routes/Broken.md": route("long", [wiki("A", 14), wiki("MissingEdge", 15)]),
    "Routes/Empty.md": route("long", []),
    "A.md": { frontmatter: { title: "Project A", aliases: "Alpha", tags: ["work", "#repeat"] },
        tags: [{ tag: "#repeat" }], headings: [heading("Overview", 15)] },
    "B.md": { frontmatter: { memory_region: "long" } },
    "C.md": {}, "Stray.md": {}, "MissingEdge.md": {}, "Active.md": {}, "Parked.md": {},
    "Source.md": {}, "Unlinked.md": {}, "SYNTHESIS/Reports/Combined.md": {},
    "synthesis/Override.md": { frontmatter: { memory_region: "long" } },
    "synthesis/Short override.md": { frontmatter: { memory_region: "short" } },
    "Other/Explicit synthesis.md": { frontmatter: { memory_region: "synthesis" } },
    "_raw/Idea.md": {}, "Notes/Inbox/Idea.md": {}, "Explicit.md": { frontmatter: { memory_region: "short" } },
    [hub]: { headings: [heading("Active", 10), heading("Ideas", 90)], links: [wiki("Active", 18),
        wiki("Routes/Reference", 20), wiki("Parked", 100)] }
};
const files = Object.keys(cache).map(path => ({ path, basename: path.split("/").pop().slice(0, -3) }));
const resolvedLinks = {
    [shortPath]: { "A.md": 1, "B.md": 1, "C.md": 1 }, "B.md": { "A.md": 1, "C.md": 1, "Source.md": 1 },
    [synthesisPath]: { "A.md": 1, "B.md": 1, "Source.md": 1 },
    "Routes/Broken synthesis.md": { "A.md": 1, "Unlinked.md": 1 },
    [longPath]: { "B.md": 1 }, "Routes/Broken.md": { "A.md": 1 }, [hub]: { "Active.md": 1, [longPath]: 1 }
};
const metadata = {
    resolvedLinks, getFileCache: file => cache[file.path],
    getFirstLinkpathDest: link => files.find(file => file.path === link + ".md")
};
const app = { vault: { getMarkdownFiles: () => files }, metadataCache: metadata };
const graph = readVaultGraph(app);
const routes = Object.fromEntries(graph.routes.map(route => [route.path, route]));
const notes = Object.fromEntries(graph.notes.map(note => [note.path, note]));
assert.deepEqual(routes[shortPath].steps.map(step => step.path), [shortPath, "A.md", "B.md", "C.md"]);
assert.equal(routes[shortPath].issue, "");
assert.equal(routes[longPath].issue, "");
assert.equal(routes[synthesisPath].issue, "");
assert.deepEqual(routes[synthesisPath].steps.map(step => step.path), [synthesisPath, "A.md", "B.md", "Source.md"]);
assert.deepEqual(routes[synthesisPath].steps.map(step => notes[step.path].region), ["synthesis", "short", "long", "long"]);
assert.deepEqual([...new Set(graph.routes.map(r => r.region))], ["short", "long", "synthesis"]);
assert.match(routes["Routes/Broken synthesis.md"].issue, /No indexed link/);
assert.equal(routes["Routes/Broken synthesis.md"].steps.length, 2);
assert.equal(notes["Unlinked.md"].region, "long");
assert.equal(notes["SYNTHESIS/Reports/Combined.md"].region, "synthesis");
assert.equal(notes["synthesis/Override.md"].region, "long");
assert.equal(notes["synthesis/Short override.md"].region, "short");
assert.equal(notes["Other/Explicit synthesis.md"].region, "synthesis");
assert.match(routes["Routes/Closed.md"].issue, /Deleted/);
assert.deepEqual(routes["Routes/Closed.md"].steps.map(s => s.path), ["Routes/Closed.md"]);
assert.match(routes["Routes/Broken.md"].issue, /No indexed link.*Project A.*MissingEdge/);
assert.equal(routes["Routes/Broken.md"].steps.length, 2);
assert.match(routes["Routes/Empty.md"].issue, /Steps/);
assert.deepEqual(notes["A.md"], { path: "A.md", label: "Project A", region: "short", aliases: ["Alpha"],
    tags: ["#repeat", "#work"], headings: ["Overview"] });
for (const path of ["B.md", longPath, "Stray.md", "Parked.md", "MissingEdge.md"]) assert.equal(notes[path].region, "long");
for (const path of ["C.md", "Active.md", "_raw/Idea.md", "Notes/Inbox/Idea.md", "Explicit.md"]) assert.equal(notes[path].region, "short");
assert.equal(graph.resolvedLinks, resolvedLinks);

metadata.resolvedLinks = undefined;
assert.match(readVaultGraph(app).routes.find(route => route.path === shortPath).issue, /No indexed link/);
metadata.getFileCache = () => null;
const startup = readVaultGraph(app);
assert.equal(startup.notes.length, files.length);
assert.deepEqual(startup.routes, []);
console.log("Memory pathway checks passed.");
