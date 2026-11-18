import concurrent.futures
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import sync


OLD = "10000000-0000-4000-8000-000000000001"
NEW = "10000000-0000-4000-8000-000000000002"
ARCH = "10000000-0000-4000-8000-000000000003"


class MemoryTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        self.vault = root / "Vault"
        self.vault.mkdir()
        self.private = root / "state"
        self.baseline = {"active": [{"id": OLD, "title": "Existing private title"}], "archived": [{"id": ARCH}]}
        self.run_command("baseline", self.baseline)

    def run_command(self, op, item):
        return sync.execute(op, item, self.private, self.vault)

    def payload(self, day=1, summary="Plan the weekly review.", **extra):
        return dict(id=NEW, updatedAt=f"2026-11-{day:02d}T20:30:00Z", summary=summary, **extra)

    def test_baseline_is_permanent_and_private(self):
        before = (self.private / "state.json").read_bytes()
        self.assertNotIn(b"Existing private title", before)
        self.assertEqual(self.run_command("baseline", {"active": [NEW], "archived": []})["status"], "already-initialized")
        with self.assertRaises(sync.Problem):
            self.run_command("baseline", {"active": []})
        rows = [dict(self.payload(), id=ID) for ID in (OLD, ARCH, NEW)] + [self.payload(2), self.payload(1)]
        pending = self.run_command("pending", rows)["pending"]
        self.assertEqual(pending, [{"id": NEW, "updatedAt": "2026-11-02T20:30:00.000000Z"}])
        self.assertEqual(before, (self.private / "state.json").read_bytes())
        for key in (OLD, ARCH):
            item = self.payload(5)
            item["id"] = key
            self.assertEqual(self.run_command("save", item)["status"], "excluded-baseline")
        self.assertEqual(list(self.vault.iterdir()), [])

    def test_save_preserves_manual_text_replay_and_time_order(self):
        made = self.run_command("save", self.payload())
        note = self.vault / made["path"]
        first = note.read_bytes()
        self.assertIn(f"https://chatgpt.com/c/{NEW}".encode(), first)
        self.assertNotIn(b"Plan the weekly review", (self.private / "state.json").read_bytes())
        note.write_bytes(b"Handwritten intro\n" + first + b"\nPrivate personal footer")
        self.assertEqual(self.run_command("save", self.payload(3, "Updated review"))["status"], "updated")
        second = note.read_bytes()
        self.assertTrue(second.startswith(b"Handwritten intro\n") and second.endswith(b"\nPrivate personal footer"))
        self.assertEqual(second.count(b"Updated review"), 1)
        self.assertNotIn(b"Plan the weekly review", second)
        self.assertEqual(self.run_command("save", self.payload(3, "Different rerun"))["status"], "unchanged")
        self.assertEqual(self.run_command("save", self.payload(2, "Late older event"))["status"], "stale")
        self.assertEqual(note.read_bytes(), second)
        self.assertEqual(self.run_command("pending", [self.payload(3)])["pending"], [])
        note.write_bytes(second.replace(b"Updated review", b"My own wording"))
        with self.assertRaises(sync.Conflict):
            self.run_command("save", self.payload(4))
        self.assertIn(b"My own wording", note.read_bytes())
        note.unlink()
        with self.assertRaises(sync.Conflict):
            self.run_command("save", self.payload(4))
        self.assertFalse(note.exists())

    def test_collision_and_paths(self):
        folder = self.vault / "Notes/ChatGPT memories"
        folder.mkdir(parents=True)
        note = folder / f"ChatGPT - {NEW}.md"
        note.write_text("My preexisting note")
        with self.assertRaises(sync.Conflict):
            self.run_command("save", self.payload())
        self.assertEqual(note.read_text(), "My preexisting note")
        note.unlink()
        target = self.private / "sentinel"
        target.write_text("outside")
        note.symlink_to(target)
        with self.assertRaises(OSError):
            self.run_command("save", self.payload())
        self.assertEqual(target.read_text(), "outside")
        note.unlink()
        folder.rmdir()
        folder.symlink_to(self.private, target_is_directory=True)
        with self.assertRaises(sync.Conflict):
            self.run_command("save", self.payload())
        self.assertEqual(list(self.private.glob("*.md")), [])
        for bad in ["../bad", "a/../../b", "foo.md", "", "hi\nbye"]:
            with self.assertRaises(sync.Problem):
                self.run_command("pending", [{"id": bad, "updatedAt": 0}])
        with self.assertRaises(sync.Problem):
            self.run_command("pending", [{"id": NEW, "updatedAt": "2026-11-01"}])
        with self.assertRaises(sync.Problem):
            self.run_command("save", self.payload(transcript="not accepted"))

    def test_opaque_and_markdown_inert(self):
        item = self.payload(summary="# Heading\n![[embed]]\n<script>small</script>", title="General topic")
        item["id"] = "connector:opaque_1"
        note = self.vault / self.run_command("save", item)["path"]
        text = note.read_text()
        self.assertNotIn("https://chatgpt.com", text)
        self.assertNotIn("[[embed]]", text)
        self.assertNotIn("<script>", text)
        self.assertIn("connector:opaque_1", text)

    def test_readable_titles_and_prose(self):
        text = sync.make_block(NEW, self.payload(summary="Keep the copy short, clear, and owner-approved.")).decode()
        self.assertIn("# Keep the copy short, clear, and owner-approved.", text)
        title = "Review " + NEW + " with person@example.org"
        heading = sync.make_block(NEW, self.payload(title=title)).decode().splitlines()[1]
        self.assertNotIn(NEW, heading)
        self.assertNotIn("@", heading)
        self.assertEqual(heading, "# Review reference with reference")
        self.assertEqual(sync.markdown_text("Prices: $199 (one-time)."), r"Prices: \$199 (one-time).")

    def test_reconcile_after_commit_failure_before_old_replay(self):
        self.run_command("save", self.payload(1))
        real_store = sync.store
        def fail_final(path, state):
            if NEW not in state["intents"]:
                raise OSError("simulated loss between note and state commit")
            real_store(path, state)
        with patch.object(sync, "store", fail_final), self.assertRaises(OSError):
            self.run_command("save", self.payload(4, "New committed text"))
        self.assertEqual(self.run_command("save", self.payload(2, "Older text"))["status"], "stale")
        note = next(self.vault.rglob("*.md"))
        self.assertIn("New committed text", note.read_text())
        self.assertEqual(self.run_command("pending", [self.payload(4)])["pending"], [])

    def test_editor_race_preserves_concurrent_change(self):
        self.run_command("save", self.payload(1))
        real_rename = sync.rename_guarded
        edited = []
        def other_writer(stage, dest, exchange):
            if exchange and not edited:
                note = dest.read_bytes() + b"\nEdit that arrived during save"
                dest.write_bytes(note)
                edited.append(note)
            return real_rename(stage, dest, exchange)
        with patch.object(sync, "rename_guarded", other_writer), self.assertRaises(sync.Conflict):
            self.run_command("save", self.payload(2, "Updated decision"))
        self.assertEqual(next(self.vault.rglob("*.md")).read_bytes(), edited[0])

    def test_hard_exit_after_exchange_recovers_competing_editor(self):
        self.run_command("save", self.payload())
        code = """import json, os, sys
sys.path.insert(0, sys.argv[1])
import sync
rename = sync.rename_guarded
def crash(stage, dest, exchange):
    with dest.open('ab') as f:
        f.write(b'\\nConcurrent handmade addition')
    rename(stage, dest, exchange)
    os._exit(27)
sync.rename_guarded = crash
sync.execute('save', json.loads(sys.argv[2]), sys.argv[3], sys.argv[4])
"""
        p = subprocess.run([sys.executable, "-IB", "-c", code, str(Path(sync.__file__).parent),
                            json.dumps(self.payload(3, "Newer summary")), str(self.private), str(self.vault)])
        self.assertEqual(p.returncode, 27)
        with self.assertRaises(sync.Conflict):
            self.run_command("save", self.payload(3, "Newer summary"))
        note = next(self.vault.rglob("*.md"))
        self.assertIn(b"Concurrent handmade addition", note.read_bytes())
        self.assertIn(b"Plan the weekly", note.read_bytes())
        self.assertEqual(self.run_command("save", self.payload(3, "Newer summary"))["status"], "updated")
        self.assertIn(b"Concurrent handmade addition", note.read_bytes())
        self.assertEqual(list(note.parent.glob(".chatgpt-memory-*")), [])

    def test_cli_and_concurrent_runs(self):
        file = self.private / "transfer"
        file.write_text(json.dumps(self.payload(2)))
        args = [sys.executable, "-B", str(Path(sync.__file__)), "save", "--vault", str(self.vault),
                "--state-dir", str(self.private), "--input", str(file)]
        def execute(_):
            p = subprocess.run(args, text=True, capture_output=True, check=True)
            return json.loads(p.stdout)["status"]
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            self.assertCountEqual(pool.map(execute, range(2)), ["created", "unchanged"])
        self.assertEqual(len(list(self.vault.rglob("*.md"))), 1)
        self.assertEqual(os.stat(self.private / "state.json").st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
