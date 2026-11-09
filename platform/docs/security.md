# Security and data integrity

Fieldwork handles sensitive workflow data. Local mode uses loopback and browser-origin checks; cloud mode additionally requires configured access authentication. This public snapshot is not a security certification or evidence of a live deployment.

## Boundaries

Mutation routes require same-origin session CSRF protection. Host and fetch-site checks complement it. Source and draft access resolve allowed roots, reject traversal and symlink escapes, and serve captured objects only through owned references. Imported HTML is escaped, not executed. PDF rendering uses restricted policies without enabling document scripting.

Expected record versions reject stale writes. Content hashes are checked before draft save, validation, publication and promotion. Draft changes invalidate prior validation. Immutable sent-package objects preserve captured bytes after source files change. Backups contain sensitive records and are not encrypted by the application; protect them separately.

## Agent verification

Adapters scope tools to purpose and draft ownership, check returned permissions and retain request/turn identity. Approvals require an explicit supported decision for the owned request. Credentials do not belong in captured context, logs, public responses or exports.

Offline protocol tests cannot establish actual OS sandbox enforcement. Validate real tool execution separately after changing an agent CLI, account or service policy. Neither a model reply nor a profile label proves a permission boundary.

## Concurrency and scope limits

Application locks coordinate participating processes; they are not protection against arbitrary code running as the same OS user. Hash guards are optimistic concurrency, not filesystem-wide atomicity. Multi-file promotion and source publication retain recovery manifests and replace only their own writes during rollback.

This is a single-owner application, not a general multi-user service. Restrict account access and data-directory permissions. Network hosting, external email, real form input and publishing require explicit setup/authorization and separate acceptance.

## Reproduce verification

Run `npm test`, `npm run build` and `npm run check` from `platform/` for the documented offline gates. Native and live-agent checks have platform/account prerequisites. Browser acceptance uses isolated synthetic fixtures and must not transmit applicant data to real forms. No historical private test report is shipped as verification of this snapshot.
