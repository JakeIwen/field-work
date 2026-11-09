# Permanent record deletion

Deletion is separate from dismissal and journal archiving. A preview identifies affected records, objects, draft files, source edits and references. Nothing is removed until the user confirms the current preview token. Cancel makes no mutation.

Company and Opening deletion can cascade to linked applications, scripts, generated documents, tasks and evidence. Shared objects and newer revisions remain when still referenced. Ordinary generation preserves sent packages; explicit deletion can remove their document entries. External backups, source-control history, remote provider sessions and employer submissions are outside this operation.

The server rechecks records and file hashes, rejects stale confirmations and active work, and refuses symlink paths. Files are restored if the database transaction fails. Small hashed tombstones suppress reimport of deleted source identities without retaining record payloads. Exports, reindex and state refresh follow successful deletion.

`GET /api/records/:kind/:id/deletion` previews; CSRF-protected `DELETE /api/records/:kind/:id` confirms. Internal bookkeeping and derived findings are not independent user records. Saved records browsing omits routine journal noise; Activity provides separate paginated journal review and reversible archiving.

Preparation updates reread surviving runs and discard late results when ownership or phase/status changed. A deleted run cannot become ready through a late packaging result. Scheduled failure handlers contain errors instead of crashing the process.

Tests should use synthetic stores and files, never live records. A passing fixture is not proof that a particular private workspace was safely deleted.
