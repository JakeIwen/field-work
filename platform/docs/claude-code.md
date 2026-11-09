# Claude Code agent

Fieldwork offers a Claude Code adapter alongside Codex. Settings selects a model and supported effort for new requests. Unavailable explicit choices fail rather than silently substituting another model. Questions can choose a model per message; see [Questions](questions.md#message-api).

## How it runs

`app/server/agent-router.ts` routes operations to the adapter owning the thread. `app/server/claude-code/agent.ts` uses the pinned Agent SDK and emits the same task-facing events as the Codex adapter. A thread belongs to one provider. Thread metadata is backed up in the application registry; interrupted turns are not automatically restarted.

Sessions isolate task execution from user/project configuration, plugins and unrelated MCP servers. Before execution the adapter checks the model, billing source, permission mode, working directory and available tools. Purpose tasks receive only their bounded Fieldwork tools; ordinary draft tasks have filesystem tools scoped to their draft and sandboxed Bash. Permission requests are approvals, not grants.

Source-tool limits are defined centrally in `app/server/context-source-limits.ts`. MCP result annotations and session output limits keep captured source reads usable without granting broader filesystem access.

## Sign-in

The adapter uses subscription sign-in and removes API-key and third-party-provider overrides from its environment. A session reporting incompatible billing is rejected. Authenticate using the installed CLI as the account that runs the backend; never copy credentials into task bundles, source control or logs. Settings reports probe failures and supports refreshing discovery.

## Live activity

In-memory live activity tracks requesting, thinking, writing, tools, retrying and compaction signals. It is distinct from persisted task activity derived from saved events. Reading live activity does not create a durable write on every stream update.

## Cloud prerequisites

Ordinary Bash tasks on Linux require the supported sandbox dependencies, including `bubblewrap` and `socat`; purpose tasks do not acquire Bash access merely because these are installed. Use deployment preparation instructions and verify actual sandboxed execution after setup changes.

## Verification

Protocol fixtures exercise SDK behavior without real model sessions. Run the platform test/build gates described in [the developer README](../README.md). Authentication, live model execution and OS sandbox enforcement require separate acceptance on the target installation; this snapshot includes no live verification claim.
