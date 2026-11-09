"""Check the actual setup preflight without SSH, sudo or any system changes."""
from pathlib import Path
import os
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent


class CloudSetupPreflightTest(unittest.TestCase):
    def preflight(self, values):
        source = (HERE / "server-setup.sh").read_text()
        preflight = source.split("env_file=/etc/fieldwork/fieldwork.env", 1)[1].split(
            '[[ "$expected_unit_hash"', 1)[0]
        with tempfile.TemporaryDirectory(prefix="fieldwork-cloud-env-") as tmp:
            env_file = Path(tmp) / "fieldwork.env"
            env_file.write_text("\n".join(f"{key}={value}" for key, value in values.items()))
            script = ('set -euo pipefail\nsudo() { if [[ "$1" == stat ]]; then '
                      'echo root:root:600; else "$@"; fi; }\n'
                      f"env_file='{env_file}'\n" + preflight + '\necho PRECHECK_OK\n')
            return subprocess.run(["bash"], input=script, text=True,
                                  capture_output=True, env=os.environ, timeout=10)

    def complete(self):
        return dict(FIELDWORK_CLOUD_ACCESS="1", FIELDWORK_OWNER_EMAIL="owner@example.com",
                    FIELDWORK_CLOUD_TEAM_URL="https://team.cloudflareaccess.com",
                    FIELDWORK_CLOUD_ACCESS_AUD="example_audience",
                    FIELDWORK_PUBLIC_ORIGIN="https://fieldwork.example.com",
                    FIELDWORK_MACHINE_TOKEN_FILE="/etc/fieldwork/machine-token")

    def test_each_cloud_key_is_required(self):
        for key in self.complete():
            with self.subTest(key=key):
                values = self.complete()
                del values[key]
                result = self.preflight(values)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(key, result.stderr)
                self.assertNotIn("owner@example.com", result.stderr)

    def test_disabled_mode_is_rejected_and_complete_mode_passes(self):
        values = self.complete()
        self.assertEqual(self.preflight(values).returncode, 0)
        for invalid in ("0", "false", "true", "2", "", "1 0", '"0"'):
            with self.subTest(mode=invalid):
                values["FIELDWORK_CLOUD_ACCESS"] = invalid
                result = self.preflight(values)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("FIELDWORK_CLOUD_ACCESS=1", result.stderr)
                self.assertNotIn("owner@example.com", result.stderr)

    def test_last_assignment_controls_validation(self):
        values = self.complete()
        values["# duplicate\nFIELDWORK_CLOUD_ACCESS"] = "0"
        self.assertNotEqual(self.preflight(values).returncode, 0)

    def test_spaced_override_cannot_disable_the_unit_cloud_gate(self):
        values = self.complete()
        values[" FIELDWORK_CLOUD_ACCESS "] = "0"
        result = self.preflight(values)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("FIELDWORK_CLOUD_ACCESS=1", result.stderr)
