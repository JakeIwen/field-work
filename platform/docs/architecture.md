# Workspace ownership and boundaries

Fieldwork separates research sources, durable workflow records and immutable document bytes. A React client calls the Node backend. The backend can run locally or as one cloud authority with a Mac companion for browser and native rendering capabilities. This document describes the design, not a verified deployment of this public snapshot.

| Data | Authority | Update rule |
| --- | --- | --- |
| Company research | `company_careers/companies.md` in the configured workspace | Scans do not rewrite the company master or watchlist choices. |
| Retained Opening research | `company_careers/current_openings.md` and dated research snapshots | Preserve identity and provenance; incomplete imports retain previous valid data. |
| General resume and evidence | Workspace source files selected by `source_data/README.md` | Source hashes guard revision validation and promotion. |
| Notes, status, bookmarks, filters and settings | SQLite | Version-checked writes; imports do not overwrite user metadata. |
| Sent packages and generated artifacts | Immutable content-addressed objects plus SQLite references | Later source edits do not alter captured bytes. |
| Task state and conversations | SQLite task records and `task_events` | Reconnect observes saved state; it does not restart interrupted work. |

Source identities use workspace-relative paths or company/requisition identities. Document revisions retain content hashes. Unknown authored dates remain unknown; filesystem timestamps are not evidence of publication or submission. Calendar-only dates remain literal dates, and display uses the shared timezone module.

## Imports and publication

Imports commit valid sections independently. A malformed section preserves the last successful records. A role missing from an incomplete source remains unconfirmed rather than closed. A source company disappearing does not erase its watchlist metadata. Complete tree reads reconcile absent documents; partial reads cannot do so.

Readable documents are hash-checked before immutable capture. HTML is displayed as extracted text, not executed. File access resolves boundaries and rejects symlink escapes. File rescans only reindex sources; [careers scans](careers-scans.md) perform explicit network collection.

## Revision ownership

Tasks work in isolated bundles containing captured sources and hashes. Validation does not publish or promote. General-master promotion rechecks source and artifact hashes, obtains a promotion lock and creates a new version directory. Prior versions remain available.

Promotion coordinates multiple file writes but is not a filesystem-wide atomic transaction. Recovery manifests and original objects record the transaction. Rollback replaces only bytes still equal to its own writes, preserving intervening edits. Back up manifests and referenced objects together.

See [bundle validation](bundle-validation.md), [security](security.md), [cloud hosting](cloud-hosting.md) and [record deletion](record-deletion.md).
