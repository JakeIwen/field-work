"""Exercise deploy failure recovery with an isolated remote-filesystem double."""
from pathlib import Path
import os
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
SSH = r'''#!/usr/bin/env python3
import os,pathlib,shlex,subprocess,sys
root=pathlib.Path(os.environ['FIELDWORK_FIXTURE_ROOT'])
command=sys.argv[-1]
body=sys.stdin.read()
if os.environ['FIELDWORK_FIXTURE_FAILURE']=='collision' and not (root/'collision-created').exists():
    release=shlex.split(command)[-1]
    stage=root/'staging'/('platform-'+release)
    stage.mkdir();(stage/'keep.txt').write_text('preexisting')
    (root/'collision-created').touch()
command=command.replace('/opt/fieldwork',str(root))
body=body.replace('/opt/fieldwork',str(root))
result=subprocess.run(['/bin/bash','-c',command],input=body,text=True)
sys.exit(result.returncode)
'''
SUDO = r'''#!/usr/bin/env python3
import os,subprocess,sys
args=sys.argv[1:]
if args[0]=='cp' and os.environ['FIELDWORK_FIXTURE_FAILURE']=='seed':sys.exit(42)
if args[0] in ['chown','chmod']:sys.exit(0)
root=os.environ['FIELDWORK_FIXTURE_ROOT']
for arg in args[1:]:
    if arg.startswith('/') and not arg.startswith(root+'/'):
        raise SystemExit('Fixture refused a path outside its remote root')
sys.exit(subprocess.run(args).returncode)
'''
RSYNC = '#!/bin/sh\nexit 43\n'


class DeployFailureTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='fieldwork-deploy-test-')
        self.root = Path(self.temp.name) / 'remote'
        for name in ['staging', 'releases', 'platform']:
            (self.root / name).mkdir(parents=True, exist_ok=True)
        (self.root / '.fieldwork-deployment-root').touch()
        (self.root / 'platform/.fieldwork-managed-code').write_text('original')
        self.bin = Path(self.temp.name) / 'bin'
        self.bin.mkdir()
        for name, text in [('ssh', SSH), ('sudo', SUDO), ('rsync', RSYNC)]:
            script = self.bin / name
            script.write_text(text)
            script.chmod(0o700)

    def tearDown(self):
        self.temp.cleanup()

    def deploy(self, failure):
        # Source publication has its own double in test_sync_sources.py.
        env = dict(os.environ, FIELDWORK_FIXTURE_ROOT=str(self.root),
                   FIELDWORK_FIXTURE_FAILURE=failure,
                   FIELDWORK_SKIP_SOURCE_SYNC='1', FIELDWORK_SSH_TARGET='fixture-host',
                   PATH=str(self.bin) + os.pathsep + os.environ['PATH'])
        result = subprocess.run(['/bin/bash', str(HERE / 'deploy.sh'), '--no-restart'],
                                env=env, capture_output=True, text=True, timeout=20)
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.root / 'platform/.fieldwork-managed-code').read_text(), 'original')
        return result

    def test_failed_seed_releases_its_lock_and_stage(self):
        self.deploy('seed')
        self.assertFalse((self.root / '.deploy-lock').exists())
        self.assertEqual(list((self.root / 'staging').iterdir()), [])

    def test_failed_upload_releases_its_lock_and_stage(self):
        self.deploy('upload')
        self.assertFalse((self.root / '.deploy-lock').exists())
        self.assertEqual(list((self.root / 'staging').iterdir()), [])

    def test_foreign_lock_is_never_removed(self):
        lock = self.root / '.deploy-lock'
        lock.mkdir()
        (lock / 'owner').write_text('different-deployment')
        self.deploy('upload')
        self.assertEqual((lock / 'owner').read_text(), 'different-deployment')

    def test_preexisting_stage_is_not_deleted(self):
        self.deploy('collision')
        self.assertFalse((self.root / '.deploy-lock').exists())
        files = list((self.root / 'staging').glob('*/keep.txt'))
        self.assertEqual(len(files), 1)
        self.assertEqual(files[0].read_text(), 'preexisting')


class DeploymentConfigurationTest(unittest.TestCase):
    """Configuration guards fail offline, before any destination can be used."""

    def env(self, **values):
        return dict({k: v for k, v in os.environ.items()
                     if not k.startswith('FIELDWORK_')}, **values)

    def run_script(self, name, *args, **values):
        return subprocess.run(['bash', str(HERE / name), *args],
                              env=self.env(**values), capture_output=True,
                              text=True, timeout=10)

    def test_ssh_destination_is_required(self):
        for name, args in [('deploy.sh', []),
                           ('server-setup.sh', []), ('live.sh', ['--dry-run'])]:
            with self.subTest(script=name):
                result = self.run_script(name, *args,
                                         FIELDWORK_PUBLIC_URL='https://fieldwork.example.com')
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('Set FIELDWORK_SSH_TARGET', result.stderr)

    def test_public_origin_is_required(self):
        for name in ['live.sh', 'configure-access.sh']:
            with self.subTest(script=name):
                result = self.run_script(name,
                                         FIELDWORK_SSH_TARGET='fixture-host',
                                         FIELDWORK_OWNER_EMAIL='owner@example.com')
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('Set FIELDWORK_PUBLIC_URL', result.stderr)

    def test_access_owner_is_required_before_loading_infrastructure(self):
        result = self.run_script('configure-access.sh')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Set FIELDWORK_OWNER_EMAIL', result.stderr)

    def test_deploy_rejects_credentials_in_public_url_before_fetch(self):
        result = self.run_script('live.sh', '--dry-run',
                                 FIELDWORK_SSH_TARGET='fixture-host',
                                 FIELDWORK_PUBLIC_URL='https://user:secret@fieldwork.example.com')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('must be an HTTPS origin', result.stderr)
        self.assertNotIn('user:secret', result.stdout + result.stderr)

    def test_access_rejects_non_origin_urls_before_loading_infrastructure(self):
        for url in ['http://fieldwork.example.com', 'https://user@fieldwork.example.com',
                    'https://fieldwork.example.com/path', 'https://fieldwork.example.com?x=1']:
            with self.subTest(url=url):
                result = self.run_script('configure-access.sh',
                                         FIELDWORK_OWNER_EMAIL='owner@example.com',
                                         FIELDWORK_PUBLIC_URL=url)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('must be an HTTPS origin', result.stderr)

    def test_access_uses_private_environment_without_disclosing_owner(self):
        with tempfile.TemporaryDirectory(prefix='fieldwork-access-test-') as tmp:
            base = Path(tmp)
            lib = base / 'scripts/lib'
            lib.mkdir(parents=True)
            (lib / 'edge-config.sh').write_text('cf_account_id() { echo fixture; }\n')
            (lib / 'cloudflare-api.sh').write_text(r"""
cf_access_app_field() { :; }
cf_api() {
  case "$1 $2" in
    'GET /accounts/fixture/access/policies?per_page=100') echo '[]' ;;
    'POST /accounts/fixture/access/policies')
      jq -e '.include[0].email.email == env.FIELDWORK_OWNER_EMAIL' <<< "$3" >/dev/null || return 1
      echo '{"id":"policy"}' ;;
    'GET /accounts/fixture/access/identity_providers') echo '[{"type":"onetimepin","id":"otp"}]' ;;
    'POST /accounts/fixture/access/apps') echo '{"id":"app","domain":"fieldwork.example.com","aud":"fixture","policies":[{"private":"fixture-owner@example.com"}]}' ;;
    *) return 1 ;;
  esac
}
""")
            output = base / 'access.json'
            result = self.run_script('configure-access.sh', str(base), str(output),
                                     FIELDWORK_OWNER_EMAIL='fixture-owner@example.com',
                                     FIELDWORK_PUBLIC_URL='https://fieldwork.example.com')
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn('fixture-owner@example.com', result.stdout + result.stderr)
            self.assertNotIn('policies', output.read_text())
            self.assertNotIn('fixture-owner@example.com', output.read_text())
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)

    def test_server_setup_only_checks_operator_owned_environment(self):
        with tempfile.TemporaryDirectory(prefix='fieldwork-setup-test-') as tmp:
            base = Path(tmp)
            bin_dir = base / 'bin'
            bin_dir.mkdir()
            env_file = base / 'fieldwork.env'
            # Run the real remote payload locally with path translation. sudo only
            # permits the read-only preflight; any later mutation fails closed.
            (bin_dir / 'ssh').write_text(r'''#!/usr/bin/env python3
import os, subprocess, sys
body = sys.stdin.read().replace('/etc/fieldwork/fieldwork.env', os.environ['FIELDWORK_FIXTURE_ENV'])
sys.exit(subprocess.run(['bash', '-s', '--', 'a' * 64], input=body, text=True).returncode)
''')
            (bin_dir / 'sudo').write_text(r'''#!/usr/bin/env python3
import os, subprocess, sys
args = sys.argv[1:]
if args[0] == 'stat':
    print('root:root:' + os.environ['FIELDWORK_FIXTURE_MODE'])
    sys.exit(0)
if args[0] == 'python3':
    sys.exit(subprocess.run(args).returncode)
print('fixture stopped before mutation', file=sys.stderr)
sys.exit(93)
''')
            for stub in bin_dir.iterdir():
                stub.chmod(0o700)
            for content, mode, permitted in [
                (None, '600', False), ('OTHER=value\n', '600', False),
                ('FIELDWORK_OWNER_EMAIL=\n', '600', False),
                ('FIELDWORK_OWNER_EMAIL=fixture-owner@example.com\n', '644', False),
                ('FIELDWORK_OWNER_EMAIL=fixture-owner@example.com\n', '600', False),
                ('FIELDWORK_OWNER_EMAIL=fixture-owner@example.com\nFIELDWORK_CLOUD_ACCESS=1\nFIELDWORK_CLOUD_TEAM_URL=https://team.cloudflareaccess.com\nFIELDWORK_CLOUD_ACCESS_AUD=example_audience\nFIELDWORK_PUBLIC_ORIGIN=https://fieldwork.example.com\nFIELDWORK_MACHINE_TOKEN_FILE=/etc/fieldwork/token\n', '600', True),
            ]:
                with self.subTest(content_present=content is not None, mode=mode, permitted=permitted):
                    if content is not None:
                        env_file.write_text(content)
                    result = self.run_script('server-setup.sh',
                                             FIELDWORK_SSH_TARGET='fixture-host',
                                             FIELDWORK_FIXTURE_ENV=str(env_file),
                                             FIELDWORK_FIXTURE_MODE=mode,
                                             PATH=str(bin_dir) + os.pathsep + os.environ['PATH'])
                    self.assertNotEqual(result.returncode, 0)
                    self.assertNotIn('fixture-owner@example.com', result.stdout + result.stderr)
                    if permitted:
                        self.assertIn('fixture stopped before mutation', result.stderr)
                    else:
                        self.assertRegex(result.stderr, 'Cloud environment must be|Incomplete cloud environment')
                        self.assertNotIn('fixture stopped before mutation', result.stderr)
                    if content is None:
                        self.assertFalse(env_file.exists())
                    else:
                        self.assertEqual(env_file.read_text(), content)


if __name__ == '__main__':
    unittest.main()
