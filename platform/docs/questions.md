# Questions, posting documents and revisions

Questions uses captured workspace evidence for answers and document tasks. Each task records its context, draft location, thread ownership and publication guards. Ordinary conversation, validated files and promoted masters are separate states.

## Task usage

Model discovery and supported efforts come from provider catalogs. Settings provides defaults for new requests. Unavailable explicit selections fail without substitution. Usage and visible activity are task-facing summaries; hidden reasoning and unrelated provider notifications are not published.

## PDF and revision ownership

Task files live in isolated bundles. New/changed source labels use captured hashes and do not imply approval. Validation checks current artifacts against captured evidence and trusted tools. General-master promotion requires final source/artifact checks and preserves previous versions. Tailored posting output uses its own publication path.

## URL limits and storage

Source tools read only allowed captured context; writes are limited to permitted task outputs. URL fetches retain guarded redirects and size limits. Thread IDs are owned by the task, not accepted as arbitrary transcript lookup keys. Backups retain task registries and artifact references, not provider credentials.

## Message API

A per-message explicit model selection uses the current thread when the provider matches. Choosing the other provider starts a seeded thread with ordered user/assistant text, the original captured context and preset tools; tool calls are not transferred. Current and historical thread IDs remain associated with the task.

Without an explicit message choice, changing a Settings default does not migrate an existing thread to a different provider. Steering preserves an active turn's model. Saved effort is used when supported, with the defined fallback otherwise. A historical thread can be read only through task ownership guards and cannot publish tools into current task state.

`GET /api/tasks/:id/threads/:threadId` reads a task-owned transcript. Shared request types and route validation define follow-up bodies, version expectations and request-ID deduplication.

## Verification

Offline fixtures exercise provider switching, carry-over, ownership and conversation rendering without real model sessions. Live credentials, sandbox execution and native document rendering are separate acceptance steps. No private conversations, screenshots or historical verification reports are included in this snapshot.
