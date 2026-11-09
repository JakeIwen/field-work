# Automation settings

Settings are persisted through version-checked writes. Shared wire shapes and validators live under `app/shared/`; server routes validate requests before saving. Defaults in code are software configuration, not evidence of an applicant's preferences.

## Schedules

Careers scans and Opening availability checks have optional schedules. The scheduler starts due work only when the workspace activity inventory permits it. Enabling a schedule does not make an incomplete scan complete, and an error remains visible and retryable. The scheduler owns last-started timestamps; saving an interval does not rewrite history.

## Fit criteria

Editable term lists screen newly discovered postings. Terms match case-insensitively with word boundaries and supported spelling variants. Required, excluded and optional criteria have separate meanings. Captured criteria stay with a run across resume/retry. Existing retained Openings are not silently re-filtered.

Technology exclusions apply to the posting body as well as its title, including preferred requirements. The configured exclusions are applicant inputs; this public documentation supplies no personal exclusion list. Pull-specific freshness, travel and language rules are captured separately; see [Pull new openings](greenhouse-pull.md).

## Duplicate postings

`canonicalPostingUrl` in `app/shared/posting-url.ts` removes tracking parameters while preserving requisition identity. `postingIdentity` recognizes supported and historical provider identities. Historical identity support does not enable a retired integration.

URL imports first match canonical URLs, then provider job identity. Publication can merge into an existing active Opening without overwriting its identity, Added dates or user metadata. Alternative URLs retain provenance. Unknown values may be filled; existing assessments are not silently replaced.

## Timing and limits

`app/shared/tunables-registry.ts` owns operational tunable definitions, units, defaults, bounds and help. Consumers read values at point of use so later work sees saved settings without a restart. Existing waits retain captured values. The tunables revision is independent of the general settings version, avoiding unrelated save conflicts.
