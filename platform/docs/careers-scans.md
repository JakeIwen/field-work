# Refresh current openings

Careers scans collect postings from monitored companies. Rescan files is separate: it only reindexes workspace sources. A scan persists company-level progress, evidence, failures and validation results so the browser can close without losing the run. Pause/resume retains completed checks; restart does not silently replay interrupted work.

Greenhouse feeds are normalized and checked for malformed or duplicate inventories. Workday pagination checks all pages and rechecks listing consistency. A later page's zero total does not prove the board is empty. Custom-page fallback uses the configured isolated browser service with guarded requests. Ashby and Lever integrations are disabled; their historical identity types remain compatibility data.

## Evidence and publication

An HTTP success alone does not prove a complete inventory. Unsupported boards, partial descriptions and unresolved postings remain incomplete. Closure requires explicit evidence, not a failed request, missing listing in a partial scan or elapsed deadline. Dismissed Openings may be omitted from individual rechecks but remain in reconciliation history.

New candidates receive provisional research status rather than a final fit recommendation. Preserve pay wording, currency, units, geographic bands and uncertainty. Existing assessments remain dated context when posting content changes. Scanning never enrolls a company or changes application status.

Validated scans publish `current_openings.md`, `scan_state.json`, `scan_history.md` and a new directory under `company_careers/research/scans/` in the configured workspace. Source-hash and monitored-pool guards reject conflicting publication. Recovery copies undo only the scan's own partial writes.

Use [Automation settings](automation-settings.md) for scheduling and criteria, [Opening validation](opening-validation.md) for availability checks, and the [Greenhouse Job Board API](https://docs.greenhouse.io/job-board.html) for provider protocol reference. No historical scan reports or private response captures are included in this snapshot.
