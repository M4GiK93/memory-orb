"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");

async function exercise() {
    const check = (value, message) => { if (!value) throw Error(message); };
    const waiting = [];
    const opened = [];
    const infos = {
        A: { label: "Alpha", neighbors: [{ path: "B", label: "Beta" }] },
        B: { label: "Beta", neighbors: [{ path: "A", label: "Alpha" }] }
    };
    const reader = new window.module.exports.Inspector(document.body, {
        getFileInfo: p => infos[p], readNote: () => new Promise((resolve, reject) => waiting.push({ resolve, reject })),
        resolveLink: p => p === "Beta" ? "B" : null, openPath: p => opened.push(p),
        goBack: () => opened.push("back"), close: () => opened.push("close")
    });
    const first = reader.show("A", false);
    await reader.show("A", false, { reload: false });
    check(waiting.length === 1, "metadata refresh interrupted the first read");
    const source = ["---","title: Alpha","---","Read [[Beta|the other note]].","~~~js",
        "[[Beta]]","~~~","Inline `[[Beta]]` ![[Beta]] [[Unresolved]]","<img src=x onerror=\"window.compromised=true\">",
        "END OF NOTE"].join("\n");
    waiting[0].resolve(source);
    await first;
    check(reader.text.textContent.includes("END OF NOTE"), "truncated note");
    check(reader.yaml.textContent.includes("title: Alpha") && !reader.properties.open, "frontmatter");
    check(!reader.text.querySelector("img,script,iframe") && !window.compromised, "interpreted HTML");
    const links = reader.text.querySelectorAll("button");
    check(links.length === 1 && links[0].textContent === "the other note", "code, embeds or display aliases");
    links[0].click();
    reader.links.querySelector("button").click();
    check(opened.join(",") === "B,B" && reader.back.disabled, "note navigation");
    const stale = reader.show("A", false);
    const next = reader.show("B", true);
    waiting[2].reject(Error("offline"));
    await next;
    const retry = reader.show("B", true, { reload: false });
    waiting[3].resolve("Second note");
    await retry;
    waiting[1].resolve("Old response");
    await stale;
    check(reader.text.textContent === "Second note", "retry or late result");
    reader.back.click();
    reader.root.querySelector("div > button:last-child").click();
    check(opened.slice(-2).join(",") === "back,close", "history controls");
    const pending = reader.show("B", true);
    delete infos.B;
    await reader.show("B", true);
    waiting[4].resolve("Removed note");
    await pending;
    check(!reader.text.textContent && reader.status.textContent.includes("removed"), "deleted note");
    const closing = reader.show("A", false);
    reader.destroy();
    waiting[5].resolve("Late after close");
    await closing;
    check(!reader.text.textContent && !document.querySelector(".memory-orb-inspector"), "teardown");
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orb-inspector-"));
try {
    const url = pathToFileURL(path.join(tmp, "test.html"));
    const inspector = fs.readFileSync(path.join(__dirname, "inspector.js"), "utf8");
    const test = "window.module={exports:{}};\n" + inspector + "\n(" + exercise.toString() +
        ")().then(()=>document.body.textContent='INSPECTOR_PASSED',e=>document.body.textContent=e.stack)";
    fs.writeFileSync(url, '<meta charset="utf-8"><body><script>' + test.replace(/<\/script/gi, "<\\/script") + "</script></body>");
    const chrome = process.env.CHROME_BIN || (process.platform === "darwin"
        ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "chromium");
    const html = execFileSync(chrome, ["--headless", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
        "--disable-background-networking", "--disable-component-update", "--host-resolver-rules=MAP * ~NOTFOUND",
        "--user-data-dir=" + path.join(tmp, "profile"), "--dump-dom", url.href],
        { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
    assert.match(html, /<body>INSPECTOR_PASSED<\/body>/);
    console.log("Memory inspector browser checks passed.");
} finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
