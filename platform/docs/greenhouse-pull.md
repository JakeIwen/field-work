# Pull new openings

Pull listings is a persisted, bounded Greenhouse discovery and research workflow. It does not start or submit applications. The selected target counts new saved Openings; reaching it is distinct from draining discovered candidates or finishing every selected search.

## Travel limit

Pull conditions capture the configured required-travel cap at run start. Deterministic screening quotes the matched clause and uses a stated range's upper bound. A disabled cap means no travel screen. Review instructions use the same captured policy, including clearly heavier non-percentage travel. Documentation does not supply an applicant's personal cap.

## Core programming languages

Captured review instructions can exclude roles defined by a language absent from supplied evidence while retaining mixed-language, preferred and incidental cases. This is distinct from full-text technology exclusions. Do not infer expertise from a search label or personal projects beyond their supported scope.

## Pull instructions

The Openings guidance panel saves instructions, search terms, employment types, excluded companies and policy together through a version-checked write. Instructions are reusable; changes affect new runs, while resume/retry retains the captured snapshot. Base prompt preview is read-only and distinguishes model instructions from deterministic code checks.

Policy defines freshness, travel, review reuse and software-title triage. Employment arrangements retain their own pay units and evidence; hourly or part-time compensation is not annualized. Unknown or multi-arrangement cases must not be discarded merely because a label is ambiguous.

## Scheduling and recovery

Search terms rotate across runs. Persisted per-search cursors request one page per step, round-robin across unfinished searches at the same page depth before advancing. Review retries and staged decisions take priority. Live parallel-review and lookahead settings admit more work without interrupting existing reviews when lowered.

Target attainment or Stop ends discovery and enters finishing, draining discovered candidates without the search-phase target cap. Stop reviews explicitly interrupts remaining review work. New pulls can start while older finishing queues settle; idle checks still include those queues.

Rate limits, visible notices, failed requests and incomplete capture preserve the same cursor and enter cooldown. Persisted pacing penalties increase on failures and recover after clean pages, never below the captured floor. Authentication, schema and identity failures stop for attention rather than masquerading as exhaustion.

The installed search userscript issues one validated same-origin request per command; the backend validates pagination and filter evidence. Missing bridge support falls back to navigation with an explicit notice. Pause/stop invalidates in-flight publication and issues no further browser commands.

## Remembered reviews and older cards

Private review memory binds decisions to captured input fingerprints and aliases. Deferrals expire according to captured policy. Reuse can be disabled per run; deterministic guards still precede remembered decisions. Explicit rereview creates a new decision rather than rewriting historical evidence.

## Excluded companies

Company exclusions use normalized name/board identity. A run uses captured exclusions plus live additions so newly excluded queued work can stop. Already-reviewing candidates and saved Openings are not rewritten. Canonical posting identity and requisition aliases deduplicate against saved, dismissed and closed records.

## Saved runs and dates

Original employer publication, provider source dates, discovery time and application Added dates are distinct. Unknown publication remains null; an update date is not original publication. Per-candidate ledgers distinguish discovery, screens, review, deferral and publication. Historical provider records remain readable but do not enable retired discovery sources.

## Pull metrics

Metrics group deterministic screens and saved review grounds with paginated evidence. Lightweight SQLite projections and response ceilings avoid hydrating entire postings/tasks for aggregate views. Duplicate identities stay out of discard totals. Metrics are lazily loaded, with explicit refresh rather than polling.

## API

`POST /api/greenhouse/pulls` accepts a target and client request ID. The compatibility `providers` field may name only Greenhouse. Guidance saves through `/api/greenhouse/guidance`; metrics read through `/api/greenhouse/metrics`. Shared types and validators define exact accepted bounds. Restart pauses interrupted searching runs; finishing queues retain their persisted policy.

No private search logs, employer samples or historical verification captures are shipped. This design description is not a claim of live discovery acceptance for the snapshot.
