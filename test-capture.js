"use strict";

const assert = require("node:assert/strict");
const { captureWriter } = require("./capture");

function fixture() {
    const entries = new Map();
    const vault = {
        entries, getAbstractFileByPath: path => entries.get(path),
        createFolder: async path => entries.set(path, { path, children: [] }),
        cachedRead: async file => file.body,
        async create(path, body) {
            if (this.fail === "before") throw new Error("Storage unavailable");
            if (entries.has(path)) throw new Error("File exists");
            const file = { path, body, extension: "md" };
            entries.set(path, file);
            entries.get(path.slice(0, path.lastIndexOf("/"))).children.push(file);
            if (this.fail === "after") throw new Error("Unknown write completion");
            return file;
        },
    };
    return vault;
}

(async () => {
    const vault = fixture(), save = captureWriter(vault);
    const draft = { text: "Keep the exact scope.\nSecond line.", title: "Scope decision" };
    for (const text of ["", "  \n", "https://chatgpt.com/share/abc", "[Our chat](https://chatgpt.com/share/abc)",
        "<https://example.com/x>", "www.example.com/a\nhttps://example.com/b", "chatgpt.com/share/test"]) {
        await assert.rejects(save({ ...draft, text }), /[Cc]opy the words/);
    }
    await assert.rejects(save({ ...draft, region: "long\nother: value" }), /Choose Working, Library, or Synthesis/);
    for (const relatedPath of ["../outside.md", ".obsidian/plugins/n.md", "/absolute.md", "Missing.md"]) {
        await assert.rejects(save({ ...draft, relatedPath }), /related note is unavailable/);
    }
    assert.equal(vault.entries.size, 0, "Invalid drafts perform no vault writes");
    vault.entries.set("projects/A.md", { path: "projects/A.md", extension: "md" });
    const [a, b] = await Promise.all([
        save({ ...draft, region: "short", relatedPath: "projects/A.md" }),
        save({ ...draft, title: "Renamed draft" }),
    ]);
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(a.file, b.file);
    assert.match(a.file.body, /^---\ntitle: "Scope decision"\nsource: ChatGPT\nmemory_region: short\n/);
    assert.match(a.file.body, /Related memory · \[\[projects\/A\]\]/);
    const combination = await save({ text: "Relate the source observations to the active project.",
        region: "synthesis", relatedPath: "projects/A.md" });
    assert.match(combination.file.body, /^memory_region: synthesis$/m);
    assert.match(combination.file.body, /Related memory · \[\[projects\/A\]\]/);
    assert.equal((await save({ ...draft, text: draft.text.replace(/\n/g, "\r\n") })).file, a.file);

    const unusual = "projects/A#bc ]].md";
    vault.entries.set(unusual, { path: unusual, extension: "md" });
    const pasted = 'Line 1\n```\n![[Should stay inert]]\n`````\n<script>ignored</script>\n---\nmemory_region: short';
    const unsafe = await save({ title: '../Escape\nheading: "xx" ![[extra]]', text: pasted, relatedPath: unusual });
    assert.match(unsafe.file.path, /^Notes\/ChatGPT memories\/[^/]+\.md$/);
    assert.match(unsafe.file.body, /\n`{6}text\n/);
    assert.ok(unsafe.file.body.includes("\n" + pasted + "\n``````\n"));
    assert.match(unsafe.file.body, /\[Related note\]\(<\.\.\/\.\.\/projects\/A%23bc%20%5D%5D\.md>\)/);
    assert.equal(unsafe.file.body.split("\n---\n", 1)[0].includes("[["), false);
    const linkInContext = await save({ title: "Source", text: "Review this example https://example.com/a tomorrow." });
    assert.equal(linkInContext.created, true);
    assert.match(linkInContext.file.body, /^memory_region: long$/m);
    const original = a.file.body;
    a.file.body = "Existing unrelated note; preserve me.";
    await assert.rejects(save(draft), /File exists/);
    assert.equal(a.file.body, "Existing unrelated note; preserve me.");
    a.file.body = original;
    vault.fail = "before";
    const pending = { text: "A recoverable draft", title: "Try again" };
    await assert.rejects(save(pending), /Storage unavailable/);
    delete vault.fail;
    assert.equal((await save(pending)).created, true);
    vault.fail = "after";
    const uncertain = { text: "Written before the adapter reported an error" };
    assert.equal((await save(uncertain)).created, false);
    assert.equal((await save(uncertain)).created, false);
    console.log("Capture passed validation, literal Markdown, safe connections, deduplication, collisions and retries.");
})().catch(error => { console.error(error); process.exitCode = 1; });
