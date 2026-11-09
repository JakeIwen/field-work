"""Exercise source publication against an isolated remote-filesystem double."""
from pathlib import Path
import json
import os
import shutil
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
DOSSIER = "source_data/github_evidence_dossier.md"
MASTER = "source_data/resume.md"
README = "source_data/README.md"
VERSION = "v15"
VERSION_TEXT = f"source_master_template/{VERSION}/resume.md"
VERSION_PDF = f"source_master_template/{VERSION}/Resume.pdf"
README_V1 = (
    "- `resume.md` — current general "
    "content master, synchronized to `source_master_template/v15/` in revision one.\n"
)
README_V2 = README_V1.replace("revision one", "revision two")
BINARY_V1 = b"%PDF-fixture-v1\x00\xff\n"
BINARY_V2 = b"%PDF-fixture-v2\x00\xff\n"
SSH = r'''#!/usr/bin/env python3
import os,pathlib,subprocess,sys,tempfile
root=os.environ['FIELDWORK_FIXTURE_ROOT']
command=sys.argv[-1]
body=sys.stdin.buffer.read()
if command=='mktemp -d':
    if os.environ.get('FIELDWORK_FIXTURE_RACE'):
        race=pathlib.Path(root,'workspace',os.environ['FIELDWORK_FIXTURE_RACE'])
        race.parent.mkdir(parents=True,exist_ok=True)
        race.write_text('edited mid-sync\n')
    print(tempfile.mkdtemp(dir=os.environ['FIELDWORK_FIXTURE_BASE']+'/tmp'))
    sys.exit(0)
def local(text):
    return (text.replace('/var/lib/fieldwork/workspace',root+'/workspace')
        .replace('/opt/fieldwork',root+'/opt'))
command=local(command)
# Only scripts are rewritten; uploaded file bytes pass through untouched.
if command.startswith('bash -s'): body=local(body.decode()).encode()
sys.exit(subprocess.run(['/bin/bash','-c',command],input=body).returncode)
'''
SUDO = r'''#!/usr/bin/env python3
import json,os,subprocess,sys
args=sys.argv[1:]
with open(os.environ['FIELDWORK_FIXTURE_SUDO_LOG'],'a') as log:
    log.write(json.dumps(args)+'\n')
if args[:2]==['-u','fieldwork']:
    args=args[2:]
if args[0]=='install':
    cleaned=[]
    skip=False
    for arg in args:
        if skip:
            skip=False
        elif arg in ['-o','-g']:
            skip=True
        else:
            cleaned.append(arg)
    args=cleaned
base=os.environ['FIELDWORK_FIXTURE_BASE']
for arg in args[1:]:
    if arg.startswith('/') and not os.path.realpath(arg).startswith(os.path.realpath(base)+'/'):
        raise SystemExit('Fixture refused a path outside its base: '+arg)
sys.exit(subprocess.run(args).returncode)
'''
SYSTEMCTL = "#!/bin/sh\nexit 3\n"


class SyncSourcesTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="fieldwork-sync-test-")
        base = Path(self.temp.name)
        self.repo = base / "repo"
        self.remote = base / "remote"
        self.workspace = self.remote / "workspace"
        self.sudo_log = base / "sudo.log"
        (self.workspace / "source_data").mkdir(parents=True)
        (self.remote / "opt").mkdir()
        (base / "tmp").mkdir()
        self.code = base / "code"
        (self.code / "platform/deploy").mkdir(parents=True)
        self.repo.mkdir()
        (self.repo / "source_data").mkdir()
        shutil.copy(HERE / "sync-sources.sh", self.code / "platform/deploy")
        self.git("init", "-q")
        self.commit(
            "agents v1\n",
            "dossier v1\n",
            "master v1\n",
            README_V1,
            "version text v1\n",
            BINARY_V1,
        )
        self.commit(
            "agents v2\n",
            "dossier v2\n",
            "master v2\n",
            README_V2,
            "version text v2\n",
            BINARY_V2,
        )
        bin_dir = base / "bin"
        bin_dir.mkdir()
        for name, text in [("ssh", SSH), ("sudo", SUDO), ("systemctl", SYSTEMCTL)]:
            (bin_dir / name).write_text(text)
            (bin_dir / name).chmod(0o700)
        self.env = dict(
            os.environ,
            FIELDWORK_FIXTURE_ROOT=str(self.remote),
            FIELDWORK_SSH_TARGET='fixture-host',
            FIELDWORK_WORKSPACE_ROOT=str(self.repo),
            FIELDWORK_FIXTURE_BASE=str(base),
            FIELDWORK_FIXTURE_SUDO_LOG=str(self.sudo_log),
            PATH=str(bin_dir) + os.pathsep + os.environ["PATH"],
        )

    def tearDown(self):
        self.temp.cleanup()

    def git(self, *args):
        subprocess.run(
            [
                "git",
                "-C",
                str(self.repo),
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                *args,
            ],
            check=True,
            capture_output=True,
        )

    @staticmethod
    def write(root, path, content):
        destination = root / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, bytes):
            destination.write_bytes(content)
        else:
            destination.write_text(content)

    def commit(self, agents, dossier, master, readme, version_text, version_pdf):
        for path, content in [
            ("AGENTS.md", agents),
            (DOSSIER, dossier),
            (MASTER, master),
            (README, readme),
            (VERSION_TEXT, version_text),
            (VERSION_PDF, version_pdf),
        ]:
            self.write(self.repo, path, content)
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "sources")

    def cloud(
        self,
        agents="agents v1\n",
        dossier="dossier v1\n",
        master="master v1\n",
        readme=README_V1,
        version_text="version text v1\n",
        version_pdf=BINARY_V1,
    ):
        for path, content in [
            ("AGENTS.md", agents),
            (DOSSIER, dossier),
            (MASTER, master),
            (README, readme),
            (VERSION_TEXT, version_text),
            (VERSION_PDF, version_pdf),
        ]:
            self.write(self.workspace, path, content)

    def cloud_legacy(self, agents="agents v1\n", dossier="dossier v1\n"):
        self.write(self.workspace, "AGENTS.md", agents)
        self.write(self.workspace, DOSSIER, dossier)

    def read_cloud(self):
        return (
            (self.workspace / "AGENTS.md").read_text(),
            (self.workspace / DOSSIER).read_text(),
        )

    def workspace_snapshot(self):
        return {
            str(path.relative_to(self.workspace)): path.read_bytes()
            for path in self.workspace.rglob("*")
            if path.is_file()
        }

    def sync(self, action, **env):
        return subprocess.run(
            ["/bin/bash", str(self.code / "platform/deploy/sync-sources.sh"), action],
            env={**self.env, **env},
            capture_output=True,
            text=True,
            timeout=30,
        )

    def test_replaces_versions_from_repository_history(self):
        self.cloud()
        result = self.sync("push")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.read_cloud(), ("agents v2\n", "dossier v2\n"))
        self.assertEqual((self.workspace / MASTER).read_text(), "master v2\n")
        self.assertIn("will be replaced", result.stdout)
        self.assertEqual(
            oct((self.workspace / DOSSIER).stat().st_mode & 0o777), "0o644"
        )
        self.assertEqual(list(self.workspace.rglob("*.fieldwork-sync")), [])

    def test_fresh_version_directory_publishes_in_order_with_binary_bytes(self):
        self.cloud_legacy()
        result = self.sync("push")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.workspace / VERSION_TEXT).read_text(), "version text v2\n")
        self.assertEqual((self.workspace / VERSION_PDF).read_bytes(), BINARY_V2)
        self.assertEqual((self.workspace / MASTER).read_text(), "master v2\n")
        self.assertEqual((self.workspace / README).read_text(), README_V2)

        ledger_paths = [
            line.split("\t", 1)[1]
            for line in (self.remote / "opt/source-sync.tsv").read_text().splitlines()
        ]
        self.assertEqual(ledger_paths[:2], ["AGENTS.md", DOSSIER])
        self.assertEqual(set(ledger_paths[2:-2]), {VERSION_TEXT, VERSION_PDF})
        self.assertEqual(ledger_paths[-2:], [MASTER, README])
        self.assertEqual(
            oct((self.workspace / f"source_master_template/{VERSION}").stat().st_mode & 0o777),
            "0o755",
        )
        for path in [VERSION_TEXT, VERSION_PDF, MASTER, README]:
            self.assertEqual(oct((self.workspace / path).stat().st_mode & 0o777), "0o644")

        sudo_calls = [json.loads(line) for line in self.sudo_log.read_text().splitlines()]
        version_directory = str(self.workspace / f"source_master_template/{VERSION}")
        self.assertIn(
            ["install", "-d", "-o", "fieldwork", "-g", "fieldwork", "-m", "0755", version_directory],
            sudo_calls,
        )
        self.assertTrue(
            any(
                call[:7]
                == ["install", "-o", "fieldwork", "-g", "fieldwork", "-m", "0644"]
                and call[-1].endswith(f"{VERSION_PDF}.fieldwork-sync")
                for call in sudo_calls
            )
        )

    def test_cloud_edit_blocks_every_file(self):
        self.cloud(dossier="promoted on the cloud\n")
        for action in ["check", "push"]:
            before = self.workspace_snapshot()
            result = self.sync(action)
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertIn("changes the selected workspace does not contain", result.stderr)
            self.assertEqual(self.workspace_snapshot(), before)

    def test_cloud_version_file_not_in_history_blocks_every_file(self):
        self.cloud(version_text="promoted version text\n")
        for action in ["check", "push"]:
            before = self.workspace_snapshot()
            result = self.sync(action)
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertIn(VERSION_TEXT, result.stderr)
            self.assertEqual(self.workspace_snapshot(), before)

    def test_cloud_readme_edit_not_in_history_blocks_every_file(self):
        self.cloud(readme=README_V2 + "cloud promotion\n")
        for action in ["check", "push"]:
            before = self.workspace_snapshot()
            result = self.sync(action)
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertIn(README, result.stderr)
            self.assertEqual(self.workspace_snapshot(), before)

    def test_check_changes_nothing(self):
        self.cloud()
        before = self.workspace_snapshot()
        result = self.sync("check")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("will be replaced", result.stdout)
        self.assertEqual(self.workspace_snapshot(), before)
        self.assertFalse((self.remote / "opt/source-sync.tsv").exists())

    def test_previous_uncommitted_sync_can_be_replaced(self):
        self.cloud(
            agents="agents v2\n",
            dossier="dossier v2\n",
            master="master v2\n",
            readme=README_V2,
            version_text="version text v2\n",
            version_pdf=BINARY_V2,
        )
        (self.repo / DOSSIER).write_text("uncommitted addendum\n")
        self.assertEqual(self.sync("push").returncode, 0)
        (self.repo / DOSSIER).write_text("revised uncommitted addendum\n")
        result = self.sync("push")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.read_cloud()[1], "revised uncommitted addendum\n")

    def test_cloud_change_during_sync_publishes_nothing(self):
        self.cloud()
        result = self.sync("push", FIELDWORK_FIXTURE_RACE=DOSSIER)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("changed on the cloud during the sync", result.stderr)
        self.assertEqual(self.read_cloud(), ("agents v1\n", "edited mid-sync\n"))
        self.assertEqual((self.workspace / MASTER).read_text(), "master v1\n")

    def test_fetch_downloads_cloud_copies(self):
        self.cloud(dossier="promoted on the cloud\n")
        result = self.sync("fetch")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        fetched = self.repo / ".local/source-sync"
        self.assertEqual((fetched / DOSSIER).read_text(), "promoted on the cloud\n")
        self.assertEqual((fetched / "AGENTS.md").read_text(), "agents v1\n")
        self.assertEqual((fetched / VERSION_PDF).read_bytes(), BINARY_V1)

    def test_fetch_skips_a_missing_cloud_file(self):
        self.cloud()
        (self.workspace / VERSION_PDF).unlink()
        result = self.sync("fetch")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(f"{VERSION_PDF}: cloud copy is missing; fetch skipped.", result.stdout)
        self.assertFalse((self.repo / ".local/source-sync" / VERSION_PDF).exists())
        self.assertEqual((self.repo / ".local/source-sync" / VERSION_TEXT).read_text(), "version text v1\n")

    def test_readme_naming_missing_version_directory_fails_clearly(self):
        (self.repo / README).write_text(README_V2.replace("v15", "v99"))
        result = self.sync("check")
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn(
            "Current general content master directory does not exist: source_master_template/v99",
            result.stderr,
        )

    def test_invalid_version_filename_fails_clearly(self):
        self.write(
            self.repo,
            f"source_master_template/{VERSION}/invalid name.txt",
            "unsafe path\n",
        )
        result = self.sync("check")
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("contains an unsupported filename: invalid name.txt", result.stderr)


if __name__ == "__main__":
    unittest.main()

class UnconfiguredSourceSyncTest(unittest.TestCase):
    def test_unset_workspace_skips_without_contacting_a_host(self):
        env = {k: v for k, v in os.environ.items() if not k.startswith("FIELDWORK_")}
        result = subprocess.run(["bash", str(HERE / "sync-sources.sh"), "check"],
                                env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Source sync skipped", result.stdout)

    def test_contributor_checkout_cannot_be_published(self):
        env = dict(os.environ, FIELDWORK_WORKSPACE_ROOT=str(HERE.parent.parent))
        result = subprocess.run(["bash", str(HERE / "sync-sources.sh"), "push"],
                                env=env, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not the contributor checkout", result.stderr)
