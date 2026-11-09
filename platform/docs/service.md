# Persistent macOS service

Fieldwork includes a macOS launchd controller. Boot-time and login-only registration are different scopes; prepare, install, start and verify are different operations. No installation is asserted for this public snapshot.

From `platform/`, inspect or prepare configuration with `npm run service:status` and `npm run service:prepare -- --boot`. Installation uses `npm run service:install -- --boot` or `npm run service:install -- --login`. Boot installation can require administrator authorization; the application worker itself must run as a non-root account. Inspect generated paths and configuration before installing.

Management commands are `service:start`, `service:stop`, `service:restart` and `service:uninstall` through npm. Stop disables supervision before unloading. Routine restart retains registration, requests graceful exit and waits for a different healthy supervised PID. Uninstall preserves workspace data. An installed but unloaded job generally needs start, not reinstall.

Status is healthy only when installed/enabled/loaded ownership, launchd PID, HTTP health and the runtime record agree. `npm run service:verify` deliberately exercises supervision and briefly disconnects the UI; run it only when work is idle. A prepared plist does not prove boot registration, and registration does not prove post-reboot acceptance.

## Local preview deployment

Use a foreground `dev:client` preview for routine client work. It proxies to the selected backend and can therefore read/write real data when aimed at a companion. Use a disposable `dev:server` backend for isolated workflow tests. `deploy:preview` stages a built client release for an existing companion; see [cloud hosting](cloud-hosting.md). A preview is not hosted-client acceptance.

## Reload from Fieldwork

Immediate Reload app interrupts owned agent turns, pauses workflows, cancels/drains tracked renderers and waits for a different healthy backend PID. Completed files remain; interrupted work requires explicit retry. Alt-click queues Reload when idle without interrupting current work. The backend owns the queue, and cancellation clears it only before restart begins.

Idle inventory includes active tasks, PDFs, scans, preparation, Greenhouse finishing/cooldown work, Gmail and pending saves. An empty stale client list does not prove idle. Writes during restart are rejected. The client retries a write only after an explicit pre-handler CSRF rejection, never after a lost or uncertain response.

Service registration is machine-local and is not restored by a data backup. Keep private credentials out of plist contents and source control. Follow [deployment documentation](../deploy/README.md) for configured hosts and paths rather than assuming any previous operator's machine settings.
