# Fieldwork cloud deployment

These scripts deploy the `platform/` application to the configured Linux host
and publish selected repository-authored sources the live app reads. The
authoritative workspace and SQLite/object data live under `/var/lib/fieldwork`
and are outside the code deployment target. Apart from the files listed under
Source publication, a deployment never copies, deletes, or changes them.

## Operator configuration

Scripts read exported environment variables; they do not source a deployment
configuration file. Destinations have no personal or production defaults.

| Variable | Purpose | Required by |
| --- | --- | --- |
| `FIELDWORK_SSH_TARGET` | SSH destination (`<cloud-host>` or an operator-chosen user/alias). | `live.sh`, `deploy.sh`, `sync-sources.sh`, `server-setup.sh` |
| `FIELDWORK_PUBLIC_URL` | Public HTTPS origin, e.g. `https://fieldwork.example.com`. Configure the same origin as the server's `FIELDWORK_PUBLIC_ORIGIN`. | `live.sh`, `configure-access.sh` |
| `FIELDWORK_OWNER_EMAIL` | Sole Cloudflare Access owner. Supply through a private environment, not command arguments. The cloud app separately reads this variable from `/etc/fieldwork/fieldwork.env`. | `configure-access.sh`; server cloud mode |
| `FIELDWORK_DEPLOY_NTFY_SCRIPT` | Absolute path to an operator-provided Python notifier accepting `--send <title> <message> default`. Unset disables background alerts; no notifier or topic is bundled. | Optional, `live.sh` |
| `FIELDWORK_WORKSPACE_ROOT` | Absolute path to a separate applicant source workspace. Unset skips source publication with a notice; the contributor checkout is never a source workspace. | Optional, `sync-sources.sh` |
| `FIELDWORK_SKIP_SOURCE_SYNC` | Set to `1` to deploy code without source publication. | Optional, `deploy.sh` (passed through by `live.sh`) |

Missing required variables fail before any connection. The generic system
account `fieldwork`, `/opt/fieldwork`, `/var/lib/fieldwork`, and loopback ports are
installation/security contracts, not owner-specific destinations.

`configure-access.sh EDGE_CHECKOUT OUTPUT_JSON` expects an operator-provided
infrastructure checkout with `scripts/lib/edge-config.sh` and
`scripts/lib/cloudflare-api.sh` (Cloudflare account/API helpers). It configures
owner-only Access before DNS publication. Its mode-0600 private output contains
only app ID, domain and audience, never the email or policy bodies.

## Local preview and production

Production uses the configured `FIELDWORK_PUBLIC_URL` (for example,
`https://fieldwork.example.com`). Local previews: `npm --prefix platform run dev:client` is a per-session hot-reload
server on the first free port from 5173, proxied to the companion at
`http://127.0.0.1:4317` (or `--api`); `npm --prefix platform run dev:server` is
a disposable local backend; 4317 is the companion itself. Never start or
advertise `dev:live`/5199. `deploy:preview` is the rare built-bundle path for
the companion. Run from the repository root:

```sh
npm --prefix platform run deploy:preview
```

This builds the working-tree client into a separate private staging directory,
checks the existing installed companion, waits/reports busy cloud work for up to
fifteen minutes, atomically publishes the local client and verifies the companion still answers.
It restarts the Mac companion (existing lifecycle controller) only with
`--restart`, needed when companion server code changed, since a restart
interrupts open browser sessions. It does not
install a service or start another listener/backend. It makes no cloud reload,
production deployment, source publication or settings write. Local preview uses
live cloud data, not an isolated copy. API, SSE, OAuth and authenticated native
capability routes keep their existing proxies and guards.

Failed builds leave the last good preview untouched; failed restarts or a companion that stops answering restore the
previous preview pointer. Missing local builds report 503, missing assets 404,
never silently falling back to the production client. Published builds live under
`.local/job-search/preview-client/` with an atomic `current.json` pointer and
retained hashed assets for old open tabs. See [cloud hosting](../docs/cloud-hosting.md)
for retention and interrupted-deployment lock recovery. Refresh the page after
a successful preview deployment. Unshipped backend dependencies remain a preview
limitation; report them instead of releasing production.

Production deployment is an explicit operator action through `npm run deploy -- --background`; see Production deployment below. Editing, building,
testing, committing or requesting local preview does not authorize deployment.

## Production deployment

After the operator authorizes a production release, run from the repository root:

```sh
npm --prefix platform run deploy [-- --ref <commit-ish>] [-- --background] [-- --dry-run]
```

`live.sh` releases a commit, never the working tree. A dirty or busy shared
checkout is normal and irrelevant: nothing here inspects it. In order:

1. `git fetch origin`, then the release ref (default `origin/main`; `--ref`
   takes any commit-ish) is resolved to a SHA and printed.
2. The machine-wide queueing lock `deploy`, the same `scripts/run-locked.mjs`
   the check and native tiers use, kept as `.local/locks/deploy/` (with an
   `owner.json` holding pid, token, start time and arguments) in the **main**
   checkout, so every linked worktree shares one queue. A live owner makes the
   run print `waiting for deploy lock held by pid N since HH:MM (...)`; a dead
   owner's lock is reclaimed once, under a recovery guard, with a message (the
   lock's tests are in `scripts/run-locked.test.mjs`). The lock is released
   only after every process the release started has exited. The locked part of
   `live.sh` is the script re-run as `live.sh --locked`; it fetches and
   resolves the ref again once the lock is its own, so a queued run deploys the
   then-current `origin/main`.
3. `.local/deploy/last.json` in the main checkout (`{sha, finishedAt, result}`,
   written by every run that held the lock). If the resolved SHA is the last
   successful deploy the run exits 3, `already deployed`, so multiple pushes queued
   behind one run produce one deploy, from any worktree.
4. A detached git worktree of the SHA in a temporary directory, with
   `node_modules` linked from this checkout, then `npm run check` there, then
   `bash deploy.sh` from it (source publication included, its sources taken from
   the explicit workspace; `FIELDWORK_WORKSPACE_ROOT`, `FIELDWORK_SKIP_SOURCE_SYNC=1` and `FIELDWORK_SSH_TARGET` pass
   through). The worktree is removed on every exit.

Everything is written to `.local/deploy/<UTC timestamp>-<sha7>.log` in the main
checkout, one line per run is appended to `.local/deploy/history.log`, and
`last.json` records the result.

`--background` starts the same run detached (own process group, stdin from
`/dev/null`, output to the log), prints the log path and exits 0 at once. When
it finishes, if `FIELDWORK_DEPLOY_NTFY_SCRIPT` is configured, it sends one alert
through that operator-provided Python notifier: `<sha7> deployed`, `<sha7> FAILED at <stage>, see <log>`
or `<sha7> already deployed`. Foreground runs print instead of alerting. A
failed check leaves production untouched; fix forward and deploy again.

`--dry-run` fetches, resolves and prints the SHA, the lock state, the last
deploy, the plan and the verification statement; it takes no lock and creates
no worktree. From a linked worktree it reports the main checkout's lock and
state paths.

Exit codes: 0 deployed, 1 failed (the stage is named: `fetch`,
`worktree`, `check` or `deploy`), 2 bad arguments (usage printed), 3 already
deployed.

When `deploy.sh` succeeds, the command prints what was and was not verified.
Verified: the offline suite on that commit, the backend health `deploy.sh`
reported after the reload, and the source publication. Not verified: the hosted
client, because nothing loads `https://fieldwork.example.com` in a browser,
so a client build that renders wrong, a broken route or a bad asset path would
go unnoticed. Production browser acceptance is still not claimed: open the site
and check Openings, an Opening detail, Applications and Settings afterwards; see
Failure and rollback below. A local `verify:browser` pass on 4317 checks the
local preview, not the hosted client.

## Explicit cloud-only deployment

`npm --prefix platform run deploy` is the normal explicit route. Run
`deploy.sh` directly only for initial installation, `--no-restart`, or another
cloud-only operation the operator explicitly authorizes, from the repository root:

```sh
npm --prefix platform run check
bash platform/deploy/deploy.sh
```

The first command runs the complete offline verification. The second deploys the
current checkout, including uncommitted code, and verifies a different healthy
cloud backend PID using the existing idle reload protocol. Running it directly
skips the release worktree, the lock and the commit selection. Commit/push
remain separate. This is
lower-level backend deployment, **not production browser acceptance**; a local
`verify:browser` pass must not be reported as checking the hosted client. This
command does not publish the local preview or restart its companion. Companion
changes need a separate idle-guarded local preview deployment. Infrastructure configuration is separate from app-code deployment.

## Source publication

`deploy.sh` uses `sync-sources.sh` only when `FIELDWORK_WORKSPACE_ROOT` names
an explicit, separate applicant workspace. With it unset, deployment prints
"Source sync skipped" and deploys code only. The public checkout's contributor
`AGENTS.md` is never published as applicant writing rules. The selected workspace
provides these sources:

- its own `AGENTS.md` writing rules and `source_data/github_evidence_dossier.md`;
- regular files inside the current `source_master_template/<version>/` named by
  its `source_data/README.md`;
- `source_data/resume.md` and `source_data/README.md`.

`sync-sources.sh check` runs before staging code. `push` runs after a healthy
release, waits for idle work and atomically publishes the selected workspace's
files, version files before `source_data/README.md`. Sources must be regular,
non-symlink files. The workspace may be a separate Git repository; its history,
not the code repository's history, supplies recognized earlier versions.

Cloud edits are preserved: a cloud file is replaced only if missing, identical,
from the source workspace's Git history, or equal to the last sync recorded in
`/opt/fieldwork/source-sync.tsv`. Otherwise publication stops. Run
`bash platform/deploy/sync-sources.sh fetch` with the same exported workspace
root to download cloud copies into that workspace's `.local/source-sync/`, then
reconcile deliberately. `FIELDWORK_SKIP_SOURCE_SYNC=1` also disables source sync.
Other research, profiles, SQLite and immutable objects are never copied by this
source publication path.

## Layout

- `/opt/fieldwork/platform`: current application code and Linux dependencies.
- `/opt/fieldwork/releases`: two most recent replaced code trees.
- `/var/lib/fieldwork/workspace`: authoritative research and resume sources.
- `/var/lib/fieldwork/workspace/.local/job-search`: SQLite, objects, drafts,
  journals, and exports. Keeping drafts below the workspace preserves Codex's
  requirement that a task working directory lie below both the repository root
  and data directory.
- `/var/lib/fieldwork/.codex`: the service account's Codex configuration.
- `/etc/fieldwork/fieldwork.env`: root-owned mode 600 service configuration.
- `/etc/fieldwork/machine-token`: fieldwork-owned mode 600 companion token.

The service reads the deployed code tree but cannot write it; systemd keeps
`/opt/fieldwork` read-only. Each code deployment replaces the complete tree
from the Mac checkout.

## Initial installation

First create `/etc/fieldwork/fieldwork.env` on the server as a regular file,
owned by `root:root` with mode `0600`, using an operator-controlled secure editor
or provisioning tool. The server reads `FIELDWORK_OWNER_EMAIL` from this file
through the systemd `EnvironmentFile`; it is required in cloud mode. Setup only
checks for its nonempty definition and the file's ownership/mode. It never
creates, replaces, prints or transports the email or environment file.
Do not put real values in source control, shell arguments, logs or shared output.

The private file must contain the deployment's actual configuration. This is a
placeholder reference, not a usable configuration:

```ini
FIELDWORK_OWNER_EMAIL=owner@example.com
FIELDWORK_CLOUD_ACCESS=1
FIELDWORK_CLOUD_TEAM_URL=https://<access-team>.cloudflareaccess.com
FIELDWORK_CLOUD_ACCESS_AUD=<dedicated-access-audience>
FIELDWORK_PUBLIC_ORIGIN=https://fieldwork.example.com
FIELDWORK_MACHINE_TOKEN_FILE=/etc/fieldwork/machine-token
FIELDWORK_COMPANION_ORIGIN=http://127.0.0.1:44318
FIELDWORK_RENDER_URL=http://127.0.0.1:44318/internal/render
```

Then run `server-setup.sh` from the repository checkout. It creates the locked,
unprivileged account and directories and installs the systemd unit. It does not
enable or start the service. A missing or insecure environment file stops setup
before account or directory changes.

Setup also runs `prepare-sandbox.sh`, following OpenAI's
[Codex sandbox guidance](https://developers.openai.com/docs/sandboxing). On
Ubuntu 24.04 it installs the distribution's `bubblewrap`, `apparmor-profiles`
and `apparmor-utils` packages when missing, then installs and reloads Ubuntu's
`bwrap-userns-restrict` profile. It does not disable the global AppArmor
user-namespace restriction or weaken the Fieldwork systemd service.

Setup also runs `prepare-companion-ssh.sh`, which installs an sshd drop-in that
drops clients after about 30 s without an answer, so the Mac companion can
rebind its reverse forward after changing networks. It reloads sshd only when
the drop-in changes, which leaves existing sessions connected. Run it alone with
`ssh "$FIELDWORK_SSH_TARGET" 'bash -s' < platform/deploy/prepare-companion-ssh.sh`.

Before the first start, replace the Access audience placeholder, install the
machine token, Codex login, authoritative workspace, and application data. The
machine token file must be a regular mode 600 file owned by `fieldwork`; the
environment file remains root-owned mode 600. Initial data provisioning is deliberately
separate from these scripts so code deployment cannot become a data-sync tool.

Use `deploy.sh --no-restart` for the initial build and promotion. After the
initial workspace is verified, a normal `deploy.sh` enables and starts the service.
Routine releases use the same command: it builds in a new staging directory,
seeds it with an independent server-local copy of the current marked code tree
so rsync uploads only changes, promotes it only after a successful build,
installs the matching systemd unit,
queues an authenticated reload when current work becomes idle, and requires a
different healthy service PID without putting the machine token in command
arguments or logs. It reports the active-work count every ten seconds and waits
up to fifteen minutes; on timeout the queued reload remains active and no forced
restart occurs. An inactive, disabled initial installation is enabled and
started directly. Other unhealthy service states fail with diagnostics instead
of interrupting possible work. A deployment lock rejects overlapping releases.
`Restart=always` lets the app's authenticated graceful reload endpoint hand
control back to systemd.

For the cloud-only `deploy.sh`, `FIELDWORK_SSH_TARGET` is required; there is
no destination default. This lower-level command does not verify a browser client
or manage the local companion. The app continues to bind only to `127.0.0.1:4317`.

## Failure and rollback

A failed dependency install or build leaves the running tree and service alone.
If restart or health verification fails, inspect the printed journal. A prior
tree remains under `/opt/fieldwork/releases`; rollback is an explicit operator
action because database or source changes made by the new app may not be
backward-compatible. Deployment removes only older code directories bearing the
private `.fieldwork-managed-code` marker.

Run `platform/deploy/test.sh` for offline syntax and contract checks. It makes no
SSH connection and changes no services.

Deployment locks carry a release owner ID. Failed preparation/upload cleans only
that owner's staging tree and lock; a foreign lock is retained. Publication waits
for the current activity inventory to become idle. Old code is pruned only after
a normal deployment passes health; `--no-restart` retains recovery releases. The
current two-directory-move activation is not crash-atomic; if interrupted during
activation, inspect current/staging/releases before retrying.

## Private cloud environment

Before `server-setup.sh`, create `/etc/fieldwork/fieldwork.env` as a regular,
non-symlink file owned by `root:root`, mode `0600`. Setup never creates or sources
it and never prints its values. It refuses an incomplete configuration. Define
all of these keys (one assignment per line; quoted values are accepted):

- `FIELDWORK_CLOUD_ACCESS=1` (also set by `fieldwork.service`);
- `FIELDWORK_OWNER_EMAIL` (the only authorized account; comparison trims and ignores case);
- `FIELDWORK_CLOUD_TEAM_URL` (your HTTPS `*.cloudflareaccess.com` team origin);
- `FIELDWORK_CLOUD_ACCESS_AUD` (your application's Access audience);
- `FIELDWORK_PUBLIC_ORIGIN` (your public HTTPS origin);
- `FIELDWORK_MACHINE_TOKEN_FILE` (absolute path to the private machine token).

Cloud mode fails closed on invalid or missing runtime configuration. Do not
set `FIELDWORK_CLOUD_ACCESS=0` in the environment file. An optional
`FIELDWORK_REFERENCE_THREAD_ID` can select a historical Codex conversation;
unset or unavailable references are omitted, not required for document generation.
