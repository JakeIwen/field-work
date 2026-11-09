# Opening availability validation

Availability validation is a resumable server-side action independent of file reindexing and careers discovery. It records URL-bound evidence and run history. Dismissed Openings are skipped by bulk validation; an explicit single-Opening request remains possible.

## Evidence and failure handling

Confirmed closure requires a provider or posting response that actually establishes closure. HTTP success with an empty shell, a blocked board, network failure or a past date-only deadline is insufficient. Ambiguous checks stay visible and do not erase a prior confirmed closure. A successful reopening check can restore visibility with evidence.

Runs expose progress, per-Opening results and recoverable failures. Cancellation, restart and retry preserve completed evidence and do not silently restart network work. Unsupported retired providers return Unknown without contacting their sites.

## Persistence

`opening_validation` records and validation-run history survive reindexing and are included in backups. Completion distinguishes availability results from actual hidden/restored visibility changes. The Opening links to its checked source; validation does not rewrite research or application state.

`POST /api/opening-validation` can name an `openingId` for an explicit check. Full endpoint contracts live in the shared types and routes. See [careers scans](careers-scans.md) and [Automation settings](automation-settings.md) for related collection and scheduling behavior.
