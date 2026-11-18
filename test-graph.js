"use strict";

const assert = require("node:assert/strict");
const { buildGraph } = require("./graph");

const project = {
    path: "Projects/Brief.md", label: "Brief", region: "short",
    aliases: ["Devis"], tags: ["#review"], headings: ["Service area"],
    body: "Check the plumber’s café appointment."
};
const reference = { path: "Reference/Brief.md", label: "Brief" };
const solo = { path: "Solo.md" };
const notes = [solo, reference, project, project];
const links = {
    [project.path]: { [reference.path]: 3, [project.path]: 1, "Image.png": 1, "Removed.md": 1 },
    [reference.path]: { [project.path]: 2 },
    "Removed.md": { [solo.path]: 1 }
};

const all = buildGraph(notes, links);
assert.equal(all.total, 3);
assert.equal(all.matches, 3);
assert.deepEqual(all.edges, [[project.path, reference.path]]);
assert.deepEqual(all.nodes, [
    { path: project.path, label: "Brief", region: "short" },
    { path: reference.path, label: "Brief", region: "long" },
    { path: solo.path, label: "Solo", region: "long" }
]);
assert.deepEqual(buildGraph([...notes].reverse(), links, "  ").nodes, all.nodes);
assert.deepEqual(buildGraph(notes, links, "brief").edges, all.edges);

for (const query of ["DEVis", "Projects/", "#review", "service area", "plumber", "brief   cafe\u0301"]) {
    const result = buildGraph(notes, links, query);
    assert.deepEqual(result, { nodes: [all.nodes[0]], edges: [], total: 3, matches: 1 }, query);
}
assert.deepEqual(buildGraph(notes, links, "unmatched"), { nodes: [], edges: [], total: 3, matches: 0 });

const moved = { ...project, path: "Projects/Renamed.md" };
assert.deepEqual(buildGraph([moved, reference], links).edges, []);
assert.deepEqual(buildGraph([moved, reference], { [reference.path]: { [moved.path]: 1 } }).edges,
    [[moved.path, reference.path]]);
assert.deepEqual(buildGraph([], undefined), { nodes: [], edges: [], total: 0, matches: 0 });
const many = Array.from({ length: 400 }, (_, index) => ({ path: `Folder/Note-${index}.md` }));
assert.equal(buildGraph(many, {}).nodes.length, many.length);
const combined = buildGraph([
    { path: "SyNtHeSiS/Patterns/Estimate.md" }, { path: "synthesis/Source.md", region: "long" },
    { path: "projects/Comparison.md", region: "synthesis" }, { path: "Notes/synthesis/Other.md" }
], { "SyNtHeSiS/Patterns/Estimate.md": { "synthesis/Source.md": 1 } });
const byPath = Object.fromEntries(combined.nodes.map(node => [node.path, node.region]));
assert.equal(byPath["SyNtHeSiS/Patterns/Estimate.md"], "synthesis");
assert.equal(byPath["synthesis/Source.md"], "long");
assert.equal(byPath["projects/Comparison.md"], "synthesis");
assert.equal(byPath["Notes/synthesis/Other.md"], "long");
assert.deepEqual(combined.edges, [["SyNtHeSiS/Patterns/Estimate.md", "synthesis/Source.md"]]);
const { neighborhood } = require("./search");
const chain = buildGraph(["a", "b", "c", "d"].map(path => ({ path })), { a: { b: 1 }, c: { b: 1, d: 1 } });
const nearby = neighborhood(chain, new Set(["b"]));
assert.deepEqual(nearby.nodes.map(n => [n.path, n.matched]), [["a", false], ["b", true], ["c", false]]);
assert.equal(nearby.matches, 1);
assert.equal(nearby.total, 4);
assert.equal(nearby.edges.length, 2);
assert.deepEqual(neighborhood(chain, new Set()).nodes, []);
console.log("Memory orb graph checks passed.");
