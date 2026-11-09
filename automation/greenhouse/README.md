# Greenhouse browser helpers

These helpers support reviewed Greenhouse application filling and bounded listing retrieval. They are not application submission tools. Use only an authorized browser session, and never test real applicant input on an employer form without explicit permission.

## Autofill

`console-helper.js` is packaged with saved scripts. The backend captures current questions, validated answers and permitted PDF attachments; the script verifies form identity, preserves existing values/files, and checks selected values and attached filenames. It never clicks Submit. Manual/ambiguous answers remain visible for review.

`fieldwork-autofill.user.js` supports Run in tab through an installed userscript manager. It accepts a handoff only from its opener on an approved Fieldwork origin, reports the exact form URL, and receives the immutable saved script only for that origin. Local HTTP loopback origins are allowed by default. For a deployed installation, add its exact HTTPS origin (for example `https://fieldwork.example.com`) to `fieldworkOrigin` in `fieldwork-autofill.user.js`, then reinstall the userscript; do not trust arbitrary opener origins. Modified application-link clicks open without autofill. Missing userscript support or handshake failure must not record a submission.

## Search

`fieldwork-search.user.js` activates with a bounded nonce and exposes a DOM command input. Each validated command issues one same-origin listing request. The backend owns page order, identity/filter validation, pacing, rate-limit cooldowns and publication. A failed request or repeated page is not terminal pagination evidence. Do not use the helper to bypass access controls or rate limits.

## Maintenance

The generated value-check contract comes from `platform/app/scripts/helper-contract.ts`. From the repository root, run `npm --prefix platform run helpers:generate` after changing that contract; drift tests check packaged output. Deployment packaging copies supported helpers into the application payload.

Keep scripts, answers and embedded applicant PDFs private. Inspect downloaded script identity and hashes before execution. [Opening workflow](../../platform/docs/opening-workflow.md) describes ownership and submission distinctions; [Pull listings](../../platform/docs/greenhouse-pull.md) describes search scheduling. This public snapshot includes no real employer examples or live browser verification reports.
