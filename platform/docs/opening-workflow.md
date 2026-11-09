# Simple Opening workflow

The Opening is the everyday workspace: add a posting URL, inspect saved research, prepare tailored documents and answers, and copy contact information. Research, document preparation and user-recorded submission are different actions. The application never treats opening a form or generating files as employer receipt.

Generate Docs runs a persisted preparation. Shift-click requests answers only. Progress, stopped states and retry controls remain available without navigating to an implementation view. Current material controls expose validated PDFs and the saved autofill script. See [combined preparation](application-preparation.md).

## Opening record authoring

Keep full source-backed research separate from short list summaries. List fields summarize location, technical fit, work-life-balance outlook and compensation without Markdown or newlines. Preserve geographic pay bands, restrictions and uncertainty. Do not annualize hourly or part-time pay.

Fit categories use `High`, `Medium`, `Low`, `Uncertain` and `Unknown`. Detailed reasoning belongs in assessment details, not category fields. High requires supporting evidence; employer flexibility or unlimited-PTO claims alone are not verified work-life balance. Remote eligibility does not imply unrestricted travel.

Assessments are concise decision notes: supported requirements, material gaps and restrictions. Resume evidence is not proof of unaided implementation or commercial adoption. Classify required, any-of and preferred technologies from the posting's own language and bind them to its source hash. Each any-of group is satisfied by one member; a separately required technology remains required.

`first_published` records original employer publication and `deadline` a real application deadline, with public `dateSources`. Unknowns stay null. Fieldwork owns creation/import dates and preserves them during research updates. Recovered historical dates require original records, not a scan timestamp.

### Source Markdown

Workspace Markdown owns research, while SQLite owns user workflow metadata. Use canonical company/requisition identity and retain source URLs and hashes. The tools validate wire fields before writing source files. Reindexing cannot overwrite bookmarks, dismissal, notes or application status.

## Reusable application answers

Reviewed answers persist for the same Opening, posting and exact question identity, including wording, descriptions, instructions, choices and constraints. User-confirmed answers take precedence over generated drafts. Changed questions do not inherit old edits. Newer answers reject stale review saves; immutable script downloads are not rewritten.

Profile facts are explicit applicant inputs, not inferred from this documentation. Ambiguous legal declarations, consent and unsupported facts stay manual unless an explicit saved policy supports the exact question. Narrative generation receives bounded captured evidence. Single-line input answers reject line breaks. Existing form values and files are preserved, and selected values and filenames are checked after filling.

## Final interpretation pass

Autofill is reviewed assistance, not submission. The saved script checks form identity, preserves manual answers and never clicks Submit. Copy can record a user-requested tracking shortcut, but that is not proof of employer receipt. Failed or uncertain attachment checks require attention rather than a success claim.

## Workspace navigation and everyday controls

Internal navigation uses `AppLink` so modified clicks retain browser behavior. Actions and local view controls remain buttons. Explanations belong in accessible hover/focus/tap tooltips; status, progress, errors and consent notices stay visible.

Opening rows distinguish Save from Not interested. Dismissal is a user flag, not employer closure. Permanent deletion is a separate preview-and-confirm workflow. Skills and date filters operate on current source-backed data, with unknown dates excluded when age filters are active. Theme changes use semantic tokens and do not alter PDF pixels.

### Greenhouse application navigation

Hosted Greenhouse links can use a server-verified direct application form instead of an employer redirect. Verification retains board/job query identity. A plain Run in tab action opens the form and hands the saved script to the installed userscript only after an exact form-URL handshake, restricted to that origin. Modified clicks open the link without autofill.

The userscript accepts scripts only from its opener on an approved Fieldwork origin. Missing userscript support or a handshake timeout records no submission. Saved script download hashes remain authoritative. Supported autofill is Greenhouse-only; historical provider identities remain readable compatibility data.
