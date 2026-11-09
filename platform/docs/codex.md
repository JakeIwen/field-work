# Codex adapter

Fieldwork talks to the installed Codex app-server through a managed adapter. The application owns its task/thread registry, captured context, requests, approval state and event history. It does not attach to unrelated desktop conversations or change global Codex configuration.

## Thread and revision ownership

`app/server/codex.ts` owns transport, lifecycle and sandbox checks. `codex-protocol.ts` reads consumed protocol fields and redacts public values. `codex-controller-lock.ts` serializes controller ownership, using process identity to avoid treating a reused PID as the original owner. Live or unverifiable owners remain protected.

A new request resolves the configured model and effort against current discovery. Explicit unavailable models fail without substitution. Existing threads retain their provider unless a per-message choice creates a separate seeded thread; see [Questions](questions.md#message-api).

Task tools read captured context and publish through task-specific validation. Ordinary drafts stay in isolated directories. Approval decisions are scoped to an owned request and accepted once. Interruptions retain saved work and require an explicit retry or follow-up rather than automatic restart.

Source hashes protect revisions from stale publication. Validation, publication and general-master promotion are separate actions. Historical task evidence remains immutable even when current source files change.

## Reproduce checks

From `platform/`, run `npm test` and `npm run build` for offline behavior and types. Protocol fixtures are not live model output. `npm run verify:codex` is a separate opt-in integration probe requiring installed credentials and available controller ownership; inspect its effects before running it on a populated workspace.

Verify actual sandboxed file access after changing CLI or service restrictions. Requested profile names and adapter responses alone are not evidence of effective OS enforcement.

## Useful fallback

If an agent cannot start, retain the task's captured inputs and expose a recoverable error. Do not broaden permissions, switch accounts or silently change providers. A manual handoff must use the same evidence and publication guards as the original task.
