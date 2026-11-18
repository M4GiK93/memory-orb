"""Save short, already-summarized ChatGPT memories in a local Obsidian vault."""
import argparse
import contextlib
import ctypes
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import unicodedata
import uuid


class Problem(ValueError):
    pass


class Conflict(Problem):
    pass


def chat_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_:-]{0,127}", value):
        raise Problem("Invalid conversation ID.")
    return str(uuid.UUID(value)) if re.fullmatch(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}", value) else value


def timestamp(value):
    try:
        if type(value) in (float, int):
            utc = dt.datetime.fromtimestamp(value / 1000 if abs(value) >= 10**11 else value, dt.timezone.utc)
        else:
            utc = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
            if utc.utcoffset() is None:
                raise ValueError()
            utc = utc.astimezone(dt.timezone.utc)
        return utc.isoformat(timespec="microseconds").replace("+00:00", "Z")
    except (TypeError, ValueError, AttributeError, OverflowError, OSError):
        raise Problem("updatedAt requires a timezone-aware timestamp or Unix epoch.") from None


def sha(data):
    return hashlib.sha256(data).hexdigest()


def clean_text(value, limit):
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise Problem("Summary or title is empty or exceeds its length limit.")
    if any(unicodedata.category(c) in {"Cc", "Cf", "Cs"} and c not in "\n\r\t" for c in value):
        raise Problem("Invalid control character in note text.")
    return " ".join(value.split())


def markdown_text(value):
    # Preserve ordinary prose punctuation while neutralizing Obsidian links, code, tags and block markers.
    value = re.sub(r"([\\`*_\[\]<>|$~^#%&])", r"\\\1", value)
    value = re.sub(r"^([-+=])(?=\s|[-=]{2,}$)|^(\d+)([.)])(?=\s)",
                   lambda m: "\\" + m[1] if m[1] else m[2] + "\\" + m[3], value)
    return re.sub(r"([a-z][a-z0-9+.-]*):(?=//)", r"\1\\:", value, flags=re.I)


def markers(key):
    return f"<!-- chatgpt-memory:{key} -->\n".encode(), f"<!-- /chatgpt-memory:{key} -->".encode()


def make_block(key, item):
    summary = clean_text(item.get("summary"), 1600)
    if item.get("title") is None:
        title = " ".join(summary.split()[:9])[:80].strip().rstrip(".!?") or "ChatGPT memory"
    else:
        title = clean_text(item["title"], 140)
    title = re.sub(r"(?i)\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b|\b\S+@\S+\.\S+|https?://\S+",
                   "reference", title)
    if item.get("title") is None and title == summary.rstrip(".!?"):
        body = "# " + markdown_text(summary)
    else:
        body = f"# {markdown_text(title)}\n\n{markdown_text(summary)}"
    if re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", key):
        body += f"\n\n[Source conversation](https://chatgpt.com/c/{key})"
    start, end = markers(key)
    return start + body.encode() + b"\n" + end


def split_note(data, key):
    start, end = markers(key)
    if data.count(start) != 1 or data.count(end) != 1:
        raise Conflict("The generated block markers were changed.")
    a = data.index(start)
    b = data.index(end)
    if b < a:
        raise Conflict("The generated block markers were changed.")
    b += len(end)
    return data[:a], data[a:b], data[b:]


def read_regular(path):
    fd = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        mode = os.fstat(fd)
        if not stat.S_ISREG(mode.st_mode) or mode.st_nlink != 1:
            raise Conflict("The destination is not a single regular file.")
        with os.fdopen(fd, "rb", closefd=False) as source:
            return source.read()
    finally:
        os.close(fd)


def stage_file(folder, data, mode=0o600):
    fd, name = tempfile.mkstemp(prefix=".chatgpt-memory-", dir=folder)
    try:
        with os.fdopen(fd, "wb") as target:
            os.fchmod(target.fileno(), mode)
            target.write(data)
            target.flush()
            os.fsync(target.fileno())
    except BaseException:
        os.unlink(name)
        raise
    return Path(name)


def sync_folder(folder):
    fd = os.open(str(folder), os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def rename_guarded(source, destination, exchange):
    # Both deployment platforms support an atomic exclusive create and an atomic name exchange.
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "darwin":
        rc = libc.renamex_np(os.fsencode(source), os.fsencode(destination), 2 if exchange else 4)
    elif sys.platform.startswith("linux"):
        rc = libc.renameat2(-100, os.fsencode(source), -100, os.fsencode(destination), 2 if exchange else 1)
    else:
        raise Problem("This platform lacks the guarded rename implementation.")
    if rc != 0:
        errno = ctypes.get_errno()
        raise OSError(errno, os.strerror(errno))


def safe_subfolder(parent, name):
    child = parent / name
    child.mkdir(mode=0o700, exist_ok=True)
    if child.is_symlink() or not child.is_dir():
        raise Conflict("A configured folder is not a real directory.")
    return child


def check_roots(state_dir, vault):
    state_dir, vault = Path(state_dir), Path(vault)
    if not state_dir.is_absolute() or not vault.is_absolute() or vault.is_symlink() or state_dir.is_symlink():
        raise Problem("Use absolute paths to actual vault and private state directories.")
    vault = vault.resolve(strict=True)
    state_dir = state_dir.resolve()
    if not vault.is_dir() or vault == state_dir or vault in state_dir.parents or state_dir in vault.parents:
        raise Problem("Private state and the vault must be separate directories.")
    state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = state_dir.stat()
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise Problem("Use a private, user-owned state directory with mode 0700.")
    return state_dir, vault


def store(path, state):
    data = json.dumps(state, sort_keys=True, separators=(",", ":")).encode()
    stage = stage_file(path.parent, data)
    try:
        os.replace(stage, path)
        sync_folder(path.parent)
    finally:
        stage.unlink(missing_ok=True)


def catalog(value):
    if not isinstance(value, list):
        raise Problem("A fully paginated catalog array is required.")
    return value


def execute(command, item, state_dir, vault):
    private, vault = check_roots(state_dir, vault)
    lock = os.open(str(private / "lock"), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock, "rb+") as guard:
        fcntl.flock(guard.fileno(), fcntl.LOCK_EX)
        path = private / "state.json"
        try:
            state = json.loads(read_regular(path))
        except FileNotFoundError:
            state = None
        if state is not None and (state.get("version") != 1 or state.get("vault") != str(vault)):
            raise Problem("Unrecognized state or different vault.")
        if command == "baseline":
            if not isinstance(item, dict) or set(item) != {"active", "archived"}:
                raise Problem("Baseline requires both complete active and archived catalogs.")
            ids = {chat_id(x.get("id") if isinstance(x, dict) else x)
                   for field in ("active", "archived") for x in catalog(item[field])}
            if state is not None:
                return {"status": "already-initialized", "count": len(state["baseline"])}
            store(path, {"version": 1, "vault": str(vault), "baseline": sorted(ids), "saved": {}, "intents": {}})
            return {"status": "initialized", "count": len(ids)}
        if state is None:
            raise Problem("Baseline must be initialized first.")
        excluded = set(state["baseline"])
        if command == "pending":
            latest = {}
            for entry in catalog(item):
                if not isinstance(entry, dict):
                    raise Problem("Each entry needs id and updatedAt.")
                key = chat_id(entry.get("id"))
                if key in excluded:
                    continue
                when = timestamp(entry.get("updatedAt"))
                if when > latest.get(key, ""):
                    latest[key] = when
            return {"pending": [{"id": k, "updatedAt": w} for k, w in latest.items()
                                if w > state["saved"].get(k, [""])[0]]}
        if command != "save" or not isinstance(item, dict) or set(item) - {"id", "updatedAt", "summary", "title"}:
            raise Problem("Save accepts only id, updatedAt, summary and optional generalized title.")
        key = chat_id(item.get("id"))
        if key in excluded:
            return {"status": "excluded-baseline"}
        when = timestamp(item.get("updatedAt"))
        block = make_block(key, item)
        return save_note(key, when, block, vault, path, state)


def save_note(key, when, block, vault, state_path, state):
    folder = safe_subfolder(safe_subfolder(vault, "Notes"), "ChatGPT memories")
    token = key if re.fullmatch(r"[0-9a-f-]{36}", key) else "id-" + sha(key.encode())
    note = folder / f"ChatGPT - {token}.md"
    result = {"path": str(note.relative_to(vault))}
    saved, intents = state["saved"], state["intents"]
    previous, intent = saved.get(key), intents.get(key)
    try:
        original = read_regular(note)
    except FileNotFoundError:
        original = None
    if intent:
        recover_stage(note, intent)
    before, after, actual = b"", b"\n", None
    if original is not None:
        if not previous and not intent:
            raise Conflict("A note already occupies the destination.")
        before, existing, after = split_note(original, key)
        actual = sha(existing)
    if intent and actual == intent[1]:
        saved[key] = previous = intent[:2]
        del intents[key]
        store(state_path, state)
        intent = None
    if previous and actual != previous[1]:
        raise Conflict("The generated note was removed or its managed text was edited.")
    if not previous and actual is not None:
        raise Conflict("Existing content does not match the pending operation.")
    if previous and when <= previous[0]:
        return dict(result, status="unchanged" if when == previous[0] else "stale")
    if intent and when < intent[0]:
        return dict(result, status="stale")
    next_record = [when, sha(block)]
    if previous and actual == next_record[1]:
        saved[key] = next_record
        intents.pop(key, None)
        store(state_path, state)
        return dict(result, status="unchanged")
    merged = before + block + after
    stage = stage_file(folder, merged, stat.S_IMODE(note.stat().st_mode) if original is not None else 0o600)
    cleanup = True
    try:
        intents[key] = next_record + [stage.name, sha(original) if original is not None else None, sha(merged)]
        store(state_path, state)
        if original is None:
            try:
                rename_guarded(stage, note, False)
            except FileExistsError:
                raise Conflict("A note arrived at the destination during creation.") from None
        else:
            rename_guarded(stage, note, True)
            # The exchanged inode contains the exact bytes an editor had at replacement time.
            cleanup = False
            if read_regular(stage) != original:
                if read_regular(note) == merged:
                    rename_guarded(stage, note, True)
                    cleanup = read_regular(stage) == merged
                raise Conflict("Concurrent edit detected; original preserved. Check the note and its staging file.")
            cleanup = True
        sync_folder(folder)
        saved[key] = next_record
        del intents[key]
        store(state_path, state)
    finally:
        if cleanup:
            stage.unlink(missing_ok=True)
    return dict(result, status="created" if original is None else "updated")


def recover_stage(note, intent):
    # A crash after exchanging names can leave the former note at its staging path.
    name, original_hash, merged_hash = intent[2:]
    if not re.fullmatch(r"\.chatgpt-memory-[a-zA-Z0-9_-]+", name):
        raise Problem("Unrecognized staging file in private state.")
    stage = note.parent / name
    try:
        captured = sha(read_regular(stage))
    except FileNotFoundError:
        return
    if captured in (original_hash, merged_hash):
        stage.unlink()
        return
    if sha(read_regular(note)) == merged_hash:
        rename_guarded(stage, note, True)
        if sha(read_regular(stage)) == merged_hash:
            stage.unlink()
        raise Conflict("Recovered an editor's concurrent changes. Review the note before retrying.")
    raise Conflict("Two concurrent edits need review. The earlier file is preserved as " + name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["baseline", "pending", "save"])
    parser.add_argument("--state-dir", required=True)
    parser.add_argument("--vault", required=True)
    parser.add_argument("--input", type=Path)
    args = parser.parse_args()
    try:
        with (args.input.open(encoding="utf-8") if args.input else contextlib.nullcontext(sys.stdin)) as source:
            item = json.load(source)
        result = execute(args.command, item, args.state_dir, args.vault)
    except Conflict as error:
        result = {"status": "conflict", "error": str(error)}
    except Problem as error:
        print(json.dumps({"status": "error", "error": str(error)}))
        return 1
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        print(json.dumps({"status": "error", "error": "Invalid input, unreadable file, or unavailable local storage."}))
        return 1
    print(json.dumps(result))
    return 2 if result.get("status") == "conflict" else 0


if __name__ == "__main__":
    sys.exit(main())
