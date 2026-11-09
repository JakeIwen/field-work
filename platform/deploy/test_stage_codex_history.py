import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("stage-codex-history.py")
REFERENCE = "00000000-0000-0000-0000-000000000001"
MANAGED = "01a11111-1111-7111-8111-111111111111"


def rollout(home: Path, thread_id: str) -> Path:
    target = home / "sessions/2026/10/12" / f"rollout-date-{thread_id}.jsonl"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps(
            {
                "timestamp": "2026-10-12T00:00:00Z",
                "type": "session_meta",
                "payload": {"id": thread_id, "cwd": "/old/workspace"},
                "ordinal": 0,
            }
        )
        + "\n",
        encoding="utf-8",
    )
    return target


class StageCodexHistoryTest(unittest.TestCase):
    def fixture(self, missing_reference: bool = False):
        temporary = tempfile.TemporaryDirectory()
        root = Path(temporary.name)
        home = root / "home"
        home.mkdir()
        managed = rollout(home, MANAGED)
        reference = None if missing_reference else rollout(home, REFERENCE)
        database = home / "state_5.sqlite"
        connection = sqlite3.connect(database)
        connection.execute("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)")
        connection.execute("INSERT INTO threads VALUES (?, ?)", (MANAGED, str(managed)))
        if reference:
            connection.execute("INSERT INTO threads VALUES (?, ?)", (REFERENCE, str(reference)))
        connection.commit()
        connection.close()
        registry = root / "codex-threads.json"
        registry.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "threads": {MANAGED: {"id": MANAGED, "cwd": "."}},
                }
            ),
            encoding="utf-8",
        )
        return temporary, home, database, registry, root / "stage"

    def run_script(self, home: Path, database: Path, registry: Path, output: Path, *, include_reference=True, reference_env=None):
        environment = os.environ.copy()
        environment.pop("FIELDWORK_REFERENCE_THREAD_ID", None)
        if reference_env is not None:
            environment["FIELDWORK_REFERENCE_THREAD_ID"] = reference_env
        return subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--codex-home",
                str(home),
                "--database",
                str(database),
                "--registry",
                str(registry),
                "--output",
                str(output),
                *(["--reference-thread", REFERENCE] if include_reference else []),
            ],
            env=environment,
            capture_output=True,
            text=True,
            check=False,
        )

    def test_stages_only_requested_rollouts_and_is_resumable(self):
        temporary, home, database, registry, output = self.fixture()
        self.addCleanup(temporary.cleanup)
        unrelated = rollout(home, "01a22222-2222-7222-8222-222222222222")
        first = self.run_script(home, database, registry, output)
        self.assertEqual(first.returncode, 0, first.stderr)
        manifest = json.loads((output / "manifest.json").read_text())
        self.assertEqual(manifest["requestedThreads"], 2)
        self.assertEqual(len(manifest["files"]), 2)
        self.assertFalse((output / "codex-home" / unrelated.relative_to(home)).exists())
        source = home / manifest["files"][0]["source"]
        destination = output / manifest["files"][0]["destination"]
        self.assertEqual(hashlib.sha256(source.read_bytes()).digest(), hashlib.sha256(destination.read_bytes()).digest())
        second = self.run_script(home, database, registry, output)
        self.assertEqual(second.returncode, 0, second.stderr)
        repeated = json.loads((output / "manifest.json").read_text())
        self.assertEqual({item["action"] for item in repeated["files"]}, {"retained"})

    def test_reports_missing_reference_without_copying_unrelated_history(self):
        temporary, home, database, registry, output = self.fixture(True)
        self.addCleanup(temporary.cleanup)
        result = self.run_script(home, database, registry, output)
        self.assertEqual(result.returncode, 2)
        manifest = json.loads((output / "manifest.json").read_text())
        self.assertEqual(manifest["missingDatabaseThreads"], [REFERENCE])
        self.assertEqual(len(manifest["files"]), 1)

    def test_reference_is_opt_in_and_can_come_from_environment(self):
        for use_environment in [False, True]:
            with self.subTest(use_environment=use_environment):
                temporary, home, database, registry, output = self.fixture()
                self.addCleanup(temporary.cleanup)
                result = self.run_script(
                    home, database, registry, output,
                    include_reference=False,
                    reference_env=REFERENCE if use_environment else None,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                manifest = json.loads((output / "manifest.json").read_text())
                self.assertEqual(manifest["requestedThreads"], 2 if use_environment else 1)
                self.assertEqual(manifest["referenceThreads"], [REFERENCE] if use_environment else [])


if __name__ == "__main__":
    unittest.main()
