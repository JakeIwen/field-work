#!/usr/bin/env python3
"""Stage only Fieldwork-owned Codex rollouts for a new CODEX_HOME."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import stat
import sys
import tempfile

REFERENCE_THREAD_ID = os.environ.get("FIELDWORK_REFERENCE_THREAD_ID", "")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_registry(path: Path) -> tuple[dict, set[str]]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if value.get("schemaVersion") != 1 or not isinstance(value.get("threads"), dict):
        raise ValueError("Invalid Fieldwork Codex thread registry")
    threads = value["threads"]
    if any(not isinstance(key, str) or not isinstance(item, dict) for key, item in threads.items()):
        raise ValueError("Invalid Fieldwork Codex thread entries")
    return value, set(threads)


def rollout_rows(database: Path, thread_ids: set[str]) -> dict[str, Path]:
    connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
    try:
        rows: dict[str, Path] = {}
        ids = sorted(thread_ids)
        for offset in range(0, len(ids), 400):
            batch = ids[offset : offset + 400]
            marks = ",".join("?" for _ in batch)
            query = f"SELECT id, rollout_path FROM threads WHERE id IN ({marks})"
            rows.update((thread_id, Path(value)) for thread_id, value in connection.execute(query, batch))
        return rows
    finally:
        connection.close()


def verified_rollout(codex_home: Path, thread_id: str, source: Path) -> Path:
    home = codex_home.resolve()
    resolved = source.resolve(strict=True)
    relative = resolved.relative_to(home)
    if relative.parts[0] not in {"sessions", "archived_sessions"}:
        raise ValueError(f"Rollout for {thread_id} is outside sessions storage")
    mode = resolved.stat().st_mode
    if not stat.S_ISREG(mode) or source.is_symlink():
        raise ValueError(f"Rollout for {thread_id} is not a regular file")
    with resolved.open("r", encoding="utf-8") as stream:
        first = json.loads(stream.readline())
    payload = first.get("payload") if first.get("type") == "session_meta" else None
    if not isinstance(payload, dict) or payload.get("id") != thread_id:
        raise ValueError(f"Rollout identity mismatch for {thread_id}")
    if not resolved.name.endswith(f"-{thread_id}.jsonl"):
        raise ValueError(f"Rollout filename mismatch for {thread_id}")
    return relative


def copy_immutable(source: Path, destination: Path, expected_hash: str) -> str:
    if destination.exists():
        if destination.is_symlink() or sha256(destination) != expected_hash:
            raise ValueError(f"Existing staged file conflicts: {destination}")
        return "retained"
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary_name = tempfile.mkstemp(prefix=f".{destination.name}.", dir=destination.parent)
    os.close(fd)
    temporary = Path(temporary_name)
    try:
        shutil.copyfile(source, temporary)
        os.chmod(temporary, 0o600)
        if sha256(temporary) != expected_hash:
            raise ValueError(f"Staged copy hash mismatch: {source}")
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)
    return "copied"


def atomic_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, indent=2, sort_keys=True)
            stream.write("\n")
        os.chmod(temporary_name, 0o600)
        os.replace(temporary_name, path)
    finally:
        Path(temporary_name).unlink(missing_ok=True)


def stage(args: argparse.Namespace) -> dict:
    codex_home = args.codex_home.resolve(strict=True)
    registry, managed = read_registry(args.registry.resolve(strict=True))
    requested = managed | set(args.reference_thread)
    rows = rollout_rows(args.database.resolve(strict=True), requested)
    missing_database = sorted(requested - rows.keys())
    missing_files: list[str] = []
    files: list[dict] = []
    for thread_id in sorted(requested & rows.keys()):
        try:
            relative = verified_rollout(codex_home, thread_id, rows[thread_id])
        except (FileNotFoundError, ValueError, OSError, json.JSONDecodeError):
            missing_files.append(thread_id)
            continue
        source = codex_home / relative
        digest = sha256(source)
        destination = args.output / "codex-home" / relative
        action = copy_immutable(source, destination, digest)
        files.append(
            {
                "threadId": thread_id,
                "source": relative.as_posix(),
                "destination": (Path("codex-home") / relative).as_posix(),
                "sha256": digest,
                "bytes": source.stat().st_size,
                "action": action,
                "kind": "managed" if thread_id in managed else "reference",
            }
        )
    registry_destination = args.output / "job-search" / "codex-threads.json"
    atomic_json(registry_destination, registry)
    manifest = {
        "schemaVersion": 1,
        "sourceCodexHome": str(codex_home),
        "registry": "job-search/codex-threads.json",
        "requestedThreads": len(requested),
        "managedThreads": len(managed),
        "referenceThreads": sorted(requested - managed),
        "files": files,
        "missingDatabaseThreads": missing_database,
        "missingRolloutThreads": sorted(missing_files),
        "excluded": ["auth.json", "state_5.sqlite", "unrelated rollouts"],
    }
    atomic_json(args.output / "manifest.json", manifest)
    return manifest


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description=__doc__)
    value.add_argument("--codex-home", type=Path, default=Path.home() / ".codex")
    value.add_argument("--database", type=Path)
    value.add_argument("--registry", type=Path, required=True)
    value.add_argument("--output", type=Path, required=True)
    value.add_argument(
        "--reference-thread",
        action="append",
        default=[REFERENCE_THREAD_ID] if REFERENCE_THREAD_ID else [],
        help="Explicit non-Fieldwork thread ID to include (repeatable; defaults to FIELDWORK_REFERENCE_THREAD_ID when set)",
    )
    return value


def main() -> int:
    args = parser().parse_args()
    args.database = args.database or args.codex_home / "state_5.sqlite"
    try:
        manifest = stage(args)
    except (OSError, ValueError, sqlite3.Error, json.JSONDecodeError) as error:
        print(f"stage-codex-history: {error}", file=sys.stderr)
        return 1
    print(
        json.dumps(
            {
                "output": str(args.output),
                "requestedThreads": manifest["requestedThreads"],
                "stagedRollouts": len(manifest["files"]),
                "missingDatabaseThreads": len(manifest["missingDatabaseThreads"]),
                "missingRolloutThreads": len(manifest["missingRolloutThreads"]),
            },
            sort_keys=True,
        )
    )
    return 2 if manifest["missingDatabaseThreads"] or manifest["missingRolloutThreads"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
