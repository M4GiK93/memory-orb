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
