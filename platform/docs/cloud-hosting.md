# Fieldwork cloud hosting

The hosting design separates one authoritative backend from a Mac companion. Example public origin: `https://fieldwork.example.com`; example owner identity: `owner@example.com`; operator-selected SSH target: `<cloud-host>`. These are placeholders, not an installed deployment.

## Ownership

The backend owns SQLite, objects, drafts, research sources, agent execution and schedules. Installed code and the mutable source workspace are separate. The companion supplies authenticated browser and native-rendering capabilities; it does not open a second copy of the backend database.

Code deployment is not a wholesale source sync. The selective source publisher guards against replacing remote edits and publishes version files before their current-version pointer. Reconcile promoted masters and source changes deliberately. Never synchronize a live SQLite file over a network filesystem or run two writers against copied databases.

## Access and connection

Cloud access verifies the configured identity provider's assertion signature, issuer, audience, expiry and allowed owner identity. Host, Origin, fetch-site and CSRF checks remain separate defenses. Configure the actual origin and account privately.

A private authenticated companion connection carries API proxy traffic and fixed browser/render capabilities. Forwarded listeners bind loopback; credentials are not URL parameters. Browser transport preserves required Host headers and exposes only configured capabilities, not an unrestricted proxy. Native rendering and signed-in browser workflows require the companion online. Ordinary backend data access does not.

Gmail Desktop OAuth authorization uses the connected companion's localhost callback. Refresh credentials are private and excluded from application backups.

## Services and deployment

Deployment scripts live in `platform/deploy/`; see [their README](../deploy/README.md) for installation-specific inputs. The release runner checks a detached commit rather than a changing checkout, serializes deployment and retains logs. Offline checks and backend health are distinct from browser acceptance of a hosted client.

Linux agents require supported sandbox packages and policy. Keep service hardening enabled and verify real file-tool execution rather than relying on a profile label. Trusted native renderer versions must agree between backend and companion; mismatches fail explicitly.

Local client preview is not production acceptance. `dev:client` proxies to its chosen backend; using a companion means reads and writes can reach real data. `dev:server` is intended for disposable fixture data. A local preview build has separate staged assets and an atomic publication pointer; failed builds preserve the last release.

## Migration and recovery

Create an application-consistent backup and preserve source authority and private configuration separately. Verify referenced objects before cutover. Stop the old writer before enabling the new one. Compare record contents and object integrity, not just health responses. Retain a recovery copy outside the destination host.

Rollback must stop the current writer before restoring a previous authority; a stale snapshot must never silently replace newer work. Application backups do not encrypt data or replace separate credential/source backups. No migration, cloud connection or hosted browser session has been verified for this public snapshot.
