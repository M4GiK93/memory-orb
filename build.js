"use strict";

// Obsidian mobile loads a single main.js and supplies the obsidian module.
const fs = require("node:fs");
const path = require("node:path");
const read = name => fs.readFileSync(path.join(__dirname, name), "utf8");
const target = path.join(__dirname, "dist");
fs.mkdirSync(target, { recursive: true });
const modules = ["graph", "pathways", "orb", "search", "inspector", "capture"];
const bundled = modules.map(name =>
    "const " + name + " = (() => { const module = { exports: {} };\n" +
    read(name + ".js") + "\nreturn module.exports; })();\n"
).join("\n");
const entry = read("plugin.js").replace(/require\("\.\/(graph|pathways|orb|search|inspector|capture)"\)/g, "$1");
fs.writeFileSync(path.join(target, "main.js"), '"use strict";\n' + bundled + entry);
fs.writeFileSync(path.join(target, "styles.css"), [read("styles.css"), read("navigation.css"), read("inspector.css")].join("\n"));
fs.copyFileSync(path.join(__dirname, "manifest.json"), path.join(target, "manifest.json"));
