"""live.sh queues on the shared lock, then releases a fetched commit from a throwaway worktree.

Lock mechanics (waits, stale reclaim) are tested in scripts/run-locked.test.mjs.
git, node and bash are real (a local bare repository stands in for origin); npm,
deploy.sh and the ntfy script are stubs that log to STUB_LOG.
"""
from pathlib import Path
import json
import os
import shutil
import subprocess
import tempfile
import time
import unittest

HERE = Path(__file__).resolve().parent
GIT_ENV = dict(os.environ, GIT_AUTHOR_NAME='t', GIT_AUTHOR_EMAIL='t@example.com',
               GIT_COMMITTER_NAME='t', GIT_COMMITTER_EMAIL='t@example.com')
DEPLOY_STUB = r'''#!/usr/bin/env bash
git_head=$(git -C "$(dirname "$0")" rev-parse HEAD)
printf 'deploy %s %s skip=%s pgid=%s\n' "$0" "$git_head" "${FIELDWORK_SKIP_SOURCE_SYNC-unset}" "$(ps -o pgid= -p $$ | tr -d ' ')" >> "$STUB_LOG"
exit "${STUB_DEPLOY_EXIT:-0}"
'''
NPM_STUB = r'''#!/usr/bin/env bash
printf 'npm %s\n' "$*" >> "$STUB_LOG"
exit "${STUB_NPM_EXIT:-0}"
'''
NTFY_STUB = '''import os, sys
with open(os.environ["STUB_LOG"], "a") as f:
    f.write("ntfy " + " | ".join(sys.argv[1:]) + "\\n")
'''
POLL_MS = '100'


class LiveDeployTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='fieldwork-live-test-')
        base = Path(self.temp.name).resolve()
        self.repo, self.tmp, self.bin = base / 'repo', base / 'tmp', base / 'bin'
        self.origin, self.other = base / 'origin.git', base / 'other'
        self.log = base / 'commands.log'
        self.ntfy = base / 'ntfy.py'
        self.state = self.repo / '.local' / 'deploy'
        self.lock = self.repo / '.local' / 'locks' / 'deploy'
        deploy = self.repo / 'platform' / 'deploy'
        deploy.mkdir(parents=True)
        self.tmp.mkdir()
        self.bin.mkdir()
        shutil.copy(HERE / 'live.sh', deploy / 'live.sh')
        scripts = self.repo / 'platform' / 'scripts'
        scripts.mkdir()
        for name in ('run-locked.mjs', 'process-group.mjs'):
            shutil.copy(HERE.parent / 'scripts' / name, scripts / name)
        (deploy / 'deploy.sh').write_text(DEPLOY_STUB)
        (self.bin / 'npm').write_text(NPM_STUB)
        (self.bin / 'npm').chmod(0o700)
        self.ntfy.write_text(NTFY_STUB)
        self.git('init', '-q', '--bare', '-b', 'main', str(self.origin), cwd=base)
        for args in (['init', '-q', '-b', 'main'], ['add', '-A'],
                     ['commit', '-q', '-m', 'Initial commit'],
                     ['remote', 'add', 'origin', str(self.origin)],
                     ['push', '-q', 'origin', 'main']):
            self.git(*args)
        self.head = self.rev('HEAD')

    def tearDown(self):
        self.temp.cleanup()

    def git(self, *args, cwd=None):
        return subprocess.run(['git', *args], cwd=cwd or self.repo, env=GIT_ENV, check=True,
                              text=True, capture_output=True)

    def rev(self, ref):
        return self.git('rev-parse', ref).stdout.strip()

    def push_from_elsewhere(self):
        """A commit another session pushed; this checkout's origin/main is stale until fetched."""
        if not self.other.exists():
            self.git('clone', '-q', str(self.origin), str(self.other), cwd=self.tmp)
        (self.other / 'new.txt').write_text(str(time.time()))
        self.git('add', '-A', cwd=self.other)
        self.git('commit', '-q', '-m', 'Pushed elsewhere', cwd=self.other)
        self.git('push', '-q', 'origin', 'main', cwd=self.other)
        return self.git('rev-parse', 'HEAD', cwd=self.other).stdout.strip()

    def env(self, **extra):
        # A shell with deploy overrides set must not change what the tests see.
        base = {k: v for k, v in GIT_ENV.items()
                if not k.startswith('FIELDWORK_')}
        base['FIELDWORK_SSH_TARGET'] = 'fixture-host'
        base.update(extra)
        return dict(base, TMPDIR=str(self.tmp), STUB_LOG=str(self.log),
                    FIELDWORK_LOCK_POLL_MS=POLL_MS, FIELDWORK_LOCK_NOTICE_MS='50',
                    FIELDWORK_DEPLOY_NTFY_SCRIPT=str(self.ntfy),
                    FIELDWORK_PUBLIC_URL='https://fieldwork.example.com',
                    PATH=str(self.bin) + os.pathsep + os.environ['PATH'])

    def live_args(self, *args):
        return ['bash', str(self.repo / 'platform/deploy/live.sh'), *args]

    def run_live(self, *args, **env):
        return subprocess.run(self.live_args(*args), cwd=self.repo, env=self.env(**env),
                              text=True, capture_output=True, timeout=30)

    def start_live(self, *args, **env):
        return subprocess.Popen(self.live_args(*args), cwd=self.repo, env=self.env(**env),
                                text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)

    def commands(self):
        return self.log.read_text().splitlines() if self.log.exists() else []

    def last(self):
        return json.loads((self.state / 'last.json').read_text())

    def history(self):
        return (self.state / 'history.log').read_text().splitlines()

    def hold_lock(self, pid):
        self.lock.mkdir(parents=True)
        (self.lock / 'owner.json').write_text(json.dumps(
            {'pid': pid, 'token': 'test-holder', 'started': '2026-11-07T01:23:00-07:00',
             'argv': ['bash', 'live.sh', '--locked'], 'cwd': '/'}))
        return self.lock

    def write_last(self, sha, result='success'):
        self.state.mkdir(parents=True, exist_ok=True)
        (self.state / 'last.json').write_text(json.dumps(
            {'sha': sha, 'finishedAt': '2026-11-07T00:00:00Z', 'result': result}))

    def assert_no_worktree_left(self):
        listing = self.git('worktree', 'list', '--porcelain').stdout
        self.assertEqual(listing.count('worktree '), 1, listing)
        self.assertEqual(list(self.tmp.iterdir()), [] if not self.other.exists() else [self.other])

    def wait_for(self, predicate, what, timeout=20):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if predicate():
                return
            time.sleep(0.05)
        self.fail(f'timed out waiting for {what}')

    def test_unknown_argument_prints_usage(self):
        for args in (('--skip-check',), ('--dry-run', '--now'), ('--ref',), ('extra',)):
            with self.subTest(args=args):
                result = self.run_live(*args)
                self.assertEqual(result.returncode, 2)
                self.assertIn('Usage:', result.stderr)
                self.assertEqual(self.commands(), [])
                self.assertFalse(self.state.exists())

    def test_a_dirty_checkout_is_accepted_and_the_release_is_origin_main(self):
        (self.repo / 'unreviewed.txt').write_text('draft')
        (self.repo / 'platform/deploy/deploy.sh').write_text(DEPLOY_STUB + '# edited\n')
        self.git('commit', '-q', '--allow-empty', '-m', 'Local only, not pushed')
        result = self.run_live()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(self.head, self.commands()[-1])
        self.assertNotEqual(self.rev('HEAD'), self.head)
        self.assertNotIn('uncommitted', result.stdout + result.stderr)
        self.assertEqual((self.repo / 'unreviewed.txt').read_text(), 'draft')

    def test_default_ref_is_origin_main_after_a_fetch(self):
        newer = self.push_from_elsewhere()
        self.assertEqual(self.rev('origin/main'), self.head)
        result = self.run_live()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(newer, self.commands()[-1])
        self.assertIn(f'Deployed {newer[:7]} to', result.stdout)

    def test_ref_option_deploys_another_commit(self):
        self.git('commit', '-q', '--allow-empty', '-m', 'Side commit')
        side = self.rev('HEAD')
        for args in (('--ref', side), (f'--ref={side[:10]}',)):
            with self.subTest(args=args):
                self.log.unlink(missing_ok=True)
                shutil.rmtree(self.state, ignore_errors=True)
                result = self.run_live(*args)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(side, self.commands()[-1])
                self.assertIn(f'Deployed {side[:7]} to', result.stdout)

    def test_unresolvable_ref_fails_at_fetch(self):
        result = self.run_live('--ref', 'no-such-branch')
        self.assertEqual(result.returncode, 1)
        self.assertIn('Cannot resolve release ref', result.stderr)
        self.assertEqual(self.commands(), [])

    def test_success_checks_and_deploys_from_the_throwaway_worktree(self):
        result = self.run_live(FIELDWORK_SSH_TARGET='other-host')
        self.assertEqual(result.returncode, 0, result.stderr)
        npm, deploy = self.commands()
        prefix = npm.split()[2]
        self.assertTrue(prefix.startswith(str(self.tmp)) and prefix.endswith('/checkout/platform'), npm)
        self.assertTrue(npm.endswith('run check'), npm)
        self.assertEqual(deploy.split()[:3], ['deploy', f'{prefix[:-len("platform")]}platform/deploy/deploy.sh', self.head])
        self.assertIn('skip=unset', deploy)
        short = self.head[:7]
        self.assertIn(f'Deployed {short} to https://fieldwork.example.com via FIELDWORK_SSH_TARGET=other-host.',
                      result.stdout)
        self.assertIn(f'Verified: the offline check suite passed on commit {short}; deploy.sh reported the '
                      'cloud backend healthy after the reload; workspace sources were not published (FIELDWORK_WORKSPACE_ROOT is unset).',
                      result.stdout)
        self.assertIn('Not verified: this command did not exercise the hosted client.', result.stdout)
        self.assertIn('What that means: open https://fieldwork.example.com', result.stdout)
        self.assertEqual(self.last()['sha'], self.head)
        self.assertEqual(self.last()['result'], 'success')
        self.assertTrue(self.history()[-1].split()[1:3] == ['deployed', short], self.history())
        logs = list(self.state.glob('*.log'))
        self.assertEqual(sorted(p.name for p in logs if p.name != 'history.log')[0][-12:], f'-{short}.log')
        self.assertIn(f'Deployed {short} to', next(p for p in logs if p.name != 'history.log').read_text())
        self.assertFalse(self.lock.exists())
        self.assertEqual([c for c in self.commands() if c.startswith('ntfy')], [])
        self.assert_no_worktree_left()

    def test_explicit_workspace_is_reflected_in_the_verified_line(self):
        result = self.run_live(FIELDWORK_WORKSPACE_ROOT='/fixture/applicant-workspace')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('sources from the explicitly selected workspace were published.', result.stdout)

    def test_skipping_source_sync_changes_the_verified_line(self):
        result = self.run_live(FIELDWORK_SKIP_SOURCE_SYNC='1')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('workspace sources were not published (FIELDWORK_SKIP_SOURCE_SYNC=1).', result.stdout)
        self.assertIn('skip=1', self.commands()[-1])

    def test_failed_check_stops_before_deploy_names_the_stage_and_removes_the_worktree(self):
        result = self.run_live(STUB_NPM_EXIT='3')
        self.assertEqual(result.returncode, 1)
        self.assertIn('Deploy FAILED at stage check', result.stdout + result.stderr)
        self.assertEqual([line.split()[0] for line in self.commands()], ['npm'])
        self.assertNotIn('Deployed ', result.stdout)
        self.assertEqual(self.last()['result'], 'failed')
        self.assertIn('failed', self.history()[-1])
        self.assertIn('stage=check', self.history()[-1])
        self.assertFalse(self.lock.exists())
        self.assert_no_worktree_left()

    def test_failed_deploy_prints_no_statement(self):
        result = self.run_live(STUB_DEPLOY_EXIT='4')
        self.assertEqual(result.returncode, 1)
        self.assertIn('Deploy FAILED at stage deploy', result.stdout + result.stderr)
        self.assertNotIn('Deployed ', result.stdout)
        self.assertNotIn('Verified:', result.stdout)
        self.assert_no_worktree_left()

    def test_a_live_lock_owner_is_waited_for(self):
        sleeper = subprocess.Popen(['sleep', '60'])
        self.addCleanup(lambda: (sleeper.kill(), sleeper.wait()))
        lock = self.hold_lock(sleeper.pid)
        proc = self.start_live()
        time.sleep(0.8)
        self.assertIsNone(proc.poll(), 'must still be queued')
        self.assertEqual(self.commands(), [])
        shutil.rmtree(lock)
        out, _ = proc.communicate(timeout=20)
        self.assertEqual(proc.returncode, 0, out)
        self.assertIn(f'waiting for deploy lock held by pid {sleeper.pid} since', out)
        self.assertIn('(bash live.sh --locked)', out)
        self.assertIn(f'Deployed {self.head[:7]} to', out)

    def test_the_last_successful_sha_exits_3_without_deploying(self):
        self.write_last(self.head)
        result = self.run_live()
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertIn('already deployed', result.stdout)
        self.assertEqual(self.commands(), [])
        self.assertEqual(self.last()['finishedAt'], '2026-11-07T00:00:00Z')
        self.assertIn('already', self.history()[-1])
        self.assertFalse(self.lock.exists())
        self.assert_no_worktree_left()

    def test_a_failed_last_deploy_of_the_same_sha_is_retried(self):
        self.write_last(self.head, result='failed')
        result = self.run_live()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.last()['result'], 'success')

    def test_a_waiter_exits_3_when_the_holder_deployed_its_sha(self):
        sleeper = subprocess.Popen(['sleep', '60'])
        self.addCleanup(lambda: (sleeper.kill(), sleeper.wait()))
        lock = self.hold_lock(sleeper.pid)
        proc = self.start_live()
        time.sleep(0.6)
        self.write_last(self.head)
        shutil.rmtree(lock)
        out, _ = proc.communicate(timeout=20)
        self.assertEqual(proc.returncode, 3, out)
        self.assertIn('already deployed', out)
        self.assertEqual(self.commands(), [])

    def test_a_waiter_deploys_the_newest_origin_main_after_the_wait(self):
        sleeper = subprocess.Popen(['sleep', '60'])
        self.addCleanup(lambda: (sleeper.kill(), sleeper.wait()))
        lock = self.hold_lock(sleeper.pid)
        proc = self.start_live()
        time.sleep(0.6)
        newer = self.push_from_elsewhere()
        shutil.rmtree(lock)
        out, _ = proc.communicate(timeout=20)
        self.assertEqual(proc.returncode, 0, out)
        self.assertIn(newer, self.commands()[-1])

    def test_concurrent_runs_of_one_sha_deploy_it_once(self):
        # A dead owner left behind makes every contender race to reclaim it.
        dead = subprocess.Popen(['true'])
        dead.wait()
        self.hold_lock(dead.pid)
        procs = [self.start_live() for _ in range(4)]
        outs = [p.communicate(timeout=60)[0] for p in procs]
        codes = sorted(p.returncode for p in procs)
        self.assertEqual(codes, [0, 3, 3, 3], outs)
        self.assertEqual(len([c for c in self.commands() if c.startswith('deploy')]), 1)
        self.assertEqual(self.last()['result'], 'success')

    def test_dry_run_prints_the_plan_and_runs_nothing(self):
        (self.repo / 'unreviewed.txt').write_text('draft')
        self.write_last('c' * 40)
        result = self.run_live('--dry-run', '--background')
        self.assertEqual(result.returncode, 0, result.stderr)
        out = result.stdout
        self.assertIn(f'release ref: origin/main -> {self.head}', out)
        self.assertIn('lock (', out)
        self.assertIn('): free', out)
        self.assertIn('last deploy: success ccccccc at 2026-11-07T00:00:00Z', out)
        self.assertIn('worktree add --detach', out)
        self.assertIn('run check', out)
        self.assertIn('deploy.sh', out)
        self.assertIn(f'Deploying {self.head[:7]} "Initial commit" (ref origin/main, on origin/main as of the fetch)', out)
        self.assertIn('A successful run would then print (hypothetical; nothing ran):', out)
        self.assertIn('Not verified: this command did not exercise the hosted client.', out)
        self.assertEqual(self.commands(), [])
        self.assertFalse(self.lock.exists())
        self.assertEqual(sorted(p.name for p in self.state.iterdir()), ['last.json'])
        self.assert_no_worktree_left()

    def test_dry_run_reports_a_held_lock(self):
        sleeper = subprocess.Popen(['sleep', '60'])
        self.addCleanup(lambda: (sleeper.kill(), sleeper.wait()))
        self.hold_lock(sleeper.pid)
        result = self.run_live('--dry-run')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertRegex(result.stdout, rf'held by pid {sleeper.pid} since \d\d:\d\d \(bash live.sh --locked\); a real run would wait')
        self.assertTrue(self.lock.exists())

    def test_dry_run_from_a_linked_worktree_reports_the_main_checkouts_state(self):
        self.write_last('c' * 40)
        linked = self.repo.parent / 'linked'
        self.git('worktree', 'add', '-q', '--detach', str(linked))
        try:
            result = subprocess.run(['bash', str(linked / 'platform/deploy/live.sh'), '--dry-run'],
                                    cwd=linked, env=self.env(), text=True, capture_output=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            out = result.stdout
            self.assertIn(f'lock ({self.lock}): free', out)
            self.assertIn(f'state: {self.state} ', out)
            self.assertIn('last deploy: success ccccccc at 2026-11-07T00:00:00Z', out)
            self.assertIn(f'log: {self.state}/', out)
            self.assertIn(f'appended to {self.state}/history.log', out)
            self.assertNotIn(str(linked / '.local'), out)
            self.assertFalse((linked / '.local').exists())
            same = self.run_live('--dry-run')
            shared = ('lock (', 'state:', 'last deploy:', 'log:')
            pick = lambda text: [l for l in text.splitlines() if l.strip().startswith(shared)]
            self.assertEqual(pick(same.stdout), pick(out))
        finally:
            self.git('worktree', 'remove', '--force', str(linked))

    def wait_for_ntfy(self, count):
        self.wait_for(lambda: len([c for c in self.commands() if c.startswith('ntfy')]) >= count,
                      'the phone alert')
        time.sleep(0.3)  # a second alert would show up by now

    def test_background_returns_at_once_and_alerts_once_on_success(self):
        started = time.time()
        result = self.run_live('--background')
        self.assertLess(time.time() - started, 5)
        self.assertEqual(result.returncode, 0, result.stderr)
        log = Path(result.stdout.strip().split('Log: ')[-1])
        self.assertEqual(log.parent, self.state)
        self.assertTrue(log.name.endswith(f'-{self.head[:7]}.log'), log)
        self.wait_for_ntfy(1)
        ntfy = [c for c in self.commands() if c.startswith('ntfy')]
        self.assertEqual(ntfy, [f'ntfy --send | fieldwork deploy | {self.head[:7]} deployed | default'])
        self.assertIn(f'Deployed {self.head[:7]} to', log.read_text())
        self.assertEqual(self.last()['result'], 'success')
        deploy = next(c for c in self.commands() if c.startswith('deploy'))
        self.assertNotEqual(int(deploy.split('pgid=')[1]), os.getpgid(0), 'must leave the caller process group')
        self.assert_no_worktree_left()

    def test_background_alerts_once_on_failure_and_removes_the_worktree(self):
        result = self.run_live('--background', STUB_NPM_EXIT='3')
        self.assertEqual(result.returncode, 0, result.stderr)
        log = Path(result.stdout.strip().split('Log: ')[-1])
        self.wait_for_ntfy(1)
        ntfy = [c for c in self.commands() if c.startswith('ntfy')]
        self.assertEqual(ntfy, [f'ntfy --send | fieldwork deploy | {self.head[:7]} FAILED at check, see {log} | default'])
        self.assertIn('Deploy FAILED at stage check', log.read_text())
        self.assertEqual(self.last()['result'], 'failed')
        self.assert_no_worktree_left()

    def test_background_alerts_when_already_deployed(self):
        self.write_last(self.head)
        result = self.run_live('--background')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.wait_for_ntfy(1)
        ntfy = [c for c in self.commands() if c.startswith('ntfy')]
        self.assertEqual(ntfy, [f'ntfy --send | fieldwork deploy | {self.head[:7]} already deployed | default'])
        self.assertEqual([c for c in self.commands() if not c.startswith('ntfy')], [])


if __name__ == '__main__':
    unittest.main()
