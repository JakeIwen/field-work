# Contributor guide

Fieldwork is a single-owner job-search workspace. This public tree contains application code and synthetic fixtures, not the source owner's workspace. Treat all real applicant data, credentials, research histories and generated materials as private. Never use them as committed examples, screenshots or verification reports.

## Conventions

- Keep research sources, user metadata and immutable artifacts separate. Markdown/JSON owns research; SQLite owns workflow metadata; the application owns creation/import timestamps. Reimports preserve user choices and original dates.
- Prefer simple Opening-centered workflows. Generation, copying a script, user-recorded submission and employer receipt are different events. Never label one as proof of another.
- Use existing shared modules before adding helpers. Feature-specific code lives beside its consumer; a second consumer moves code to the nearest common feature. Entry points only compose. Avoid grab-bag utilities folders.
- Declare cross-module records and status vocabularies once. Validate external input at boundaries; static types are not runtime validation. Add stored record kinds to `app/server/records.ts`.
- Missing request-named records return 404; missing dependencies return 409. Background work fails or skips with a logged reason. Never assert a Store lookup with `!`, resurrect deleted work or crash on a late completion.
- Use Store transactions, existing atomic-write facilities and the shared clock. Persist ownership before asynchronous work; recheck record existence and phase/status before publication. Keep sent artifacts immutable.
- Put explanatory UI copy in accessible hover/focus/tap tooltips; keep status, counts, errors and operational notices visible. Use outlined button primitives and real `AppLink` URLs for navigation. Modified clicks must not mutate source-tab state.
- Theme values belong to semantic tokens; status and PDF colors retain their declared meaning. Do not change PDF pixels or the transparent selectable text layer during a UI refactor.
- Tests exercise public behavior using isolated synthetic data. Do not send email, fill real forms, mutate a populated workspace or invoke paid agents during ordinary verification. Offline fixtures do not establish live acceptance.
- Run focused tests and TypeScript for changed paths. Run the complete offline check before a release. Keep unrelated changes separate; stage only owned paths. Never publish private configuration or historical data through a documentation change.
- Comments explain why, not chronology. Keep this map current when adding a shared module. Preserve documented executable paths and contract owners.

## Development and verification

From `platform/`, `npm install` installs dependencies; do not use an install mode that removes dependencies underneath a running service. `npm test` is the fast offline tier. `npm run test:native` runs macOS-native rendering tests under its lock. `npm run build` checks structure/types and builds the client. `npm run check` is the complete offline gate with serialized native/release work where supported.

Tests use temporary stores and fixtures. Native Swift/WebKit checks require macOS; browser and real-agent acceptance are separate opt-in gates. A skipped platform check is a limitation, not proof that a workflow works. No historical verification report is evidence for this snapshot.

`dev:client` is a foreground hot-reload client that proxies to a selected backend. A companion-backed preview reads/writes that backend's real data and is not isolation. Use `dev:server` with disposable fixture data for server workflow tests. `npm run demo` serves an isolated, read-only showcase on synthetic data seeded from `platform/sample-workspace/`: `app/scripts/demo-runtime.ts` starts it with agents, scheduled integrations and outbound network disabled (`demo-network.ts` refuses child processes, non-loopback DNS and resolver queries, UDP, Unix sockets and connections to any port but the demo's own (the `demo:screenshots` process also allows the browser service on 8931); demo middleware answers agent, workflow and live-posting routes with a disabled message before the product routes), `demo-seed.ts` and `demo-content.ts` build the records, `demo-autofill.ts` makes an offline autofill script, and `demo-sources.ts`/`demo-shell.ts` prepare the workspace copy and page shell. `npm run demo:screenshots` (`demo-screenshots.ts`, `demo-capture.ts`) recaptures `platform/docs/screenshots/` through the clean browser service.

## Platform code structure

### Settings and shared rules

`platform/app/shared/tunables-registry.ts` owns operational groups, keys, units, defaults, bounds and help. `shared/tunables.ts` owns public types and validation; `server/tunables.ts` resolves live Store values at point of use. The settings route owns revision-checked patches and wake/reschedule effects. Existing waits retain their captured value. Security ceilings and process-start values are not arbitrary UI tunables.

`shared/timezone.ts` declares the display timezone default, independent of machine/browser timezone. Calendar-only values remain literal dates. Never derive authored/publication dates from import or filesystem timestamps.

`shared/palette.ts` owns palette data and validation; `client/appearance/palette.ts` owns application/save state and the editor adapter lives beside it. Theme formulas come from theme-kit. `client/styles-theme.css` owns application tokens; other styles use semantic variables. Soft/Dark is a browser preference, while saved themes and palettes have independent server revisions.

### Opening discovery and research

`server/opening-pull/` owns compatibility records, identity, source dates, validation, screening, publication and projections. Consumers import named modules directly. `contract.ts`, `dates.ts`, `identity.ts`, `research.ts`, `publication.ts`, `screen.ts`, `travel.ts`, `title-triage.ts`, `card-triage.ts` and `company-filter.ts` divide deterministic rules from orchestration.

`server/greenhouse-pull.ts` coordinates browser retrieval and publication; `greenhouse-pull-records.ts` owns persisted run/candidate records and `greenhouse-pull-start.ts` captures guidance/policy. Scheduling, stop/finishing, pacing, failures, review cooldown and activity have named sibling modules. Finishing queues still participate in idle checks. Lowering concurrency never interrupts admitted reviews.

`shared/greenhouse-policy.ts` owns configurable policy bounds and capture types. Guidance and history live in `server/opening-pull/guidance.ts` and `guidance-history.ts`; query rotation and cursors live in `greenhouse-query-plan.ts`. Captured policy survives retry; live exclusion additions can stop queued work. Review memory binds prior decisions to recoverable captured inputs and expiry rather than blindly reusing text.

`server/greenhouse-source.ts` owns the browser transport; `greenhouse-search.ts` validates page/filter evidence. `automation/greenhouse/fieldwork-search.user.js` issues one validated request per command, never independent pagination. Metrics use bounded SQLite projections in `opening-pull/metrics-read.ts` and `pull-metrics.ts`, with shared wire vocabulary. Do not hydrate whole histories for aggregate views.

`server/opening-research-policy.ts` owns research instructions and prompt templates. `opening-skills-fields.ts` validates classified required/any-of/preferred skills bound to posting hashes. `shared/opening-skill-catalog.ts` declares canonical technology names; `shared/opening-skills.ts` owns grouping and text matching. Any-of alternatives count as one requirement.

`server/careers/` owns provider collection, reconciliation and scan lifecycle. `model.ts` owns I/O-free scan types, `providers.ts` collection interfaces, `monitored.ts` scan inputs, `provider-payloads.ts` external readers and `scan-records.ts` persisted evidence readers. Scans never rewrite the company master or application metadata. `server/pay-text.ts` detects pay lines without inventing amounts. Careers and availability validation share `resumable-job.ts` and guarded HTTP infrastructure.

Only Greenhouse autofill/discovery integrations are enabled. Historical provider types, URLs and saved records remain compatibility data. `shared/posting-url.ts` owns canonical identity and retired-provider guards; do not let generic scan fallbacks silently re-enable retired sources.

### Autofill and preparation

`server/autofill/` owns profile facts, answer decisions, evidence, attachments, copying and validity. `shared/application-form.ts` owns exact question/evidence shapes. Provider registration and codecs remain at `application-autofill-contract.ts`, `application-autofill-providers.ts` and `greenhouse-autofill-codec.ts`. Greenhouse source/form/adapter/planner modules keep browser concerns distinct from answer policy.

`autofill/question-policy.ts` owns consent/manual/no-AI decisions; `evidence.ts`, `saved-answers.ts`, `attachments.ts` and `validity.ts` own their respective reads/projections. Applicant facts and explicitly saved policies must come from the configured profile, never assumptions or documentation examples. Preserve existing answers/files and never click Submit.

`application-answer-reviews.ts` owns durable review identity and stale-edit guards. `application-answers.ts` validates edits; `application-answer-partition.ts` isolates per-answer failures while keeping strict whole-request identity. Single-line inputs reject line breaks. Immutable scripts stay immutable when reviewed answers are carried forward.

`autofill/fetch.ts` retries bounded temporary reads; `fetch-errors.ts` classifies nested causes and journals retries without secrets. `autofill/form-checks.ts` persists explicit paced question-check passes; `form-questions.ts` reuses planning without drafting and `form-check-state.ts` projects current results. Newly published Openings can join an enabled check queue after publication commits.

`application-preparation.ts` coordinates queued preparation. Shared preparation settings and server settings validation bound concurrency. Full and answers-only requests share the queue but have distinct publication/stage effects. `preparation-documents.ts` validates reusable owned artifacts; `preparation-activity.ts` projects phase history and task/live activity without persisting every signal.

`document-retention.ts` prunes only unprotected older generated material and its embedded-script references. `renderer-overflow.ts`, `overflow-layout.ts`, `preparation-overflow.ts`, `overflow-followup.ts` and `overflow-recovery-ownership.ts` own bounded measured-overflow repair and request/turn ownership. Unknown ownership fails closed; cancelled or deleted work cannot publish.

`server/document-instructions.ts` owns document prose instructions. `document-writing-rules.ts` fingerprints relevant prose separately from operational documentation and output mechanics. `document-writing-status.ts` projects freshness; `application-evidence.ts` owns factual dependencies. Captured tasks keep historical rules and sources. A code refactor is not itself a reason to expire saved PDFs.

### Email

`server/gmail/manager.ts` owns scan lifecycle; `api.ts`, `auth.ts` and `send.ts` are external adapters. `matching.ts`, `positive.ts`, `rejections.ts`, `correlation.ts`, `scan.ts`, `mime.ts` and `application-updates.ts` keep decision rules separate. Shared wire records and attention vocabulary live in `shared/gmail.ts` and `shared/gmail-attention.ts`. Credentials are private and excluded from backups.

`server/follow-up-email.ts` owns drafts/history; `follow-up-email-task.ts` captures evidence and tools; `follow-up-email-send.ts` owns in-flight markers, send verification and uncertain-send recovery. `email-html.ts` renders escaped HTML from the same text as the plain part. Sending requires confirmation; uncertain sends block automatic repeats. Gmail receipts do not establish an application outcome.

### Agents and task lifecycle

`server/agent-router.ts` is the single agent surface and routes by thread-owning provider. `shared/codex-models.ts` owns request/model vocabulary; catalogs, model preferences, selection and message-model validation are named server modules. Unavailable explicit models fail without substitution.

`server/codex.ts` owns app-server transport and lifecycle; `codex-protocol.ts` reads consumed protocol fields and redacts public values. Controller locking and process identity live in `codex-controller-lock.ts` and `controller-process.ts`. Live or unverifiable owners remain protected.

`server/claude-code/` owns the SDK adapter, model discovery, isolated sessions, purpose tools, approvals, thread registry and turns. `context-source-limits.ts` keeps tool-result and source caps aligned. Purpose tools are bounded capabilities, not broad filesystem grants. Real sandbox enforcement requires separate live acceptance.

`server/task-kinds/registry.ts` declares each preset's preparation, purpose, instructions, tools, prompt and completion. `task-completion.ts` owns canonical completion/event services; `purpose-policies.ts` owns purpose tables. `task-followup.ts` deduplicates delivery. `task-carry-over.ts` seeds another provider with ordered user/assistant text, never tool calls; `shared/task-threads.ts` owns current/historical inventory. Historical threads cannot publish into current task state.

`shared/task-records.ts` owns Task and TaskSummary. Use shared busy/waiting/active predicates instead of new status lists. `server/task-activity.ts` reduces persisted events; adapter live-activity modules retain in-memory liveness separately. Task events live in `task_events`, not embedded task records, and append with the task update in one transaction.

### Storage and records

`server/storage-state-cache.ts` caches deep-frozen Store-derived parts by write version, invalidating on rollback and external commits. `storage-state.ts` declares dependencies; `state-response-json.ts` reuses byte-equivalent fragments. `storage-read-cache.ts` scopes file/clock/runtime projections to one response. `storage-openings.ts` merges source and user data with canonical identity, and `storage-application-index.ts` indexes document/application associations.

`state-encoding.ts` bounds compression concurrency. `client-task-summary.ts` omits heavy evidence only from global snapshots, not detail or storage. `storage-task-events.ts` owns event reads; migrations preserve history explicitly. `storage-export.ts` schedules secondary exports; dirty tracking, snapshots, fragments and row-wise JSON live in named `storage-export-*` neighbors. SQLite remains authoritative; a crash may leave secondary exports behind.

`record-catalog.ts` owns bounded scalar catalog projections; `record-detail.ts`, `record-relations.ts`, `record-json-preview.ts`, `record-page-cursor.ts` and `record-search.ts` own detail, links, bounds and search. `activity-log.ts` and `journal-presentation.ts` own paginated activity. `journal-archive.ts` provides reversible archiving, distinct from deletion.

`record-deletion-records.ts` owns cascade planning. Reference scans, shared-object hashes, event screening, leaf deletion, tombstones and reindex reconciliation have named `record-deletion-*` modules. Confirm current preview tokens and hashes, protect active work and shared objects, and do not resurrect removed source identities.

`backup-archive.ts` assembles consistent database, objects and workflow files. `backup-integrity.ts` owns the referenced-object inventory; `backup-promotions.ts` projects recovery references and `backup-verify.ts` checks a safely extracted archive through read-only storage. Partial backups report missing bytes instead of silently claiming completeness.

### HTTP, hosting and services

`server/server.ts` is a composition root. `routes/{system,applications,documents,greenhouse,openings,tasks}.ts` register phased routes in matching order; the error handler stays last. `withContext` reads live managers per request rather than capturing startup copies.

`workspace-entry.ts` selects backend or companion mode. `cloud-access.ts` verifies access assertions and `cloud-ingress.ts` authenticates the machine connection. Companion configuration, tunnel, browser transport, HTTP filtering and preview live in named `companion-*` files. The companion never opens the backend Store. Its destinations (`sshTarget`, a host or user@host, and `cloudOrigin`, an HTTPS origin) come from the private `companion.json` and are validated in `companion-config.ts`; the macOS service registers under the launchd label `local.fieldwork` (`server/launchd.ts`). `FIELDWORK_REFERENCE_THREAD_ID` optionally names the historical conversation that question and document tasks receive as `reference-conversation.md` (`server/question-context.ts`); when it is unset or unavailable the file and its instruction are omitted, with identical writing-rule fingerprints, and nothing is blocked. `client-security.ts` shares shell headers; `browser-service.ts` resolves fixed browser capabilities. `shared/remote-render.ts` and client/handler modules define bounded hash-checked native rendering.

`workspace-reload.ts` pauses workflows and drains cancelled generation work. `generation-control.ts` tracks render/validation/compiler processes. `workspace-activity.ts` inventories work before idle reload. `http-drain.ts` lets responses finish during shutdown instead of cutting encoded JSON mid-body. Pending queues and empty stale snapshots do not prove idle.

`app/scripts/service.ts`, `service-control.ts` and `server/launchd.ts` own macOS control, ownership/health checks and generated registration. `app/scripts/deploy-preview.ts` wires `preview-deployment.ts` staging, locks, idle checks and rollback. `platform/deploy/` contains optional cloud deployment; all origins, hosts and owner identities must be configured with placeholders replaced privately. No service is assumed installed by this guide.

### Client

`client/App.tsx` owns workspace state and shell composition. `client/shell/navigation.ts` is canonical navigation/shortcut data; `AppPage.tsx` dispatches feature pages. Toasts, shortcut help and entity URLs remain shell modules. Feature pages live in `client/pages/`; the client root is limited to entry/shell files and stylesheet manifests.

Requests go through `client/workspace/api.ts`. It retries writes only for explicit pre-handler CSRF rejection, not ambiguous transport failure. `live-events.ts` shares one event stream through Web Locks/BroadcastChannel; `state-refresh-cadence.ts` spaces event refetches, pauses hidden tabs and refreshes on visibility. Browser storage is optional preference storage, never durable shared records.

`client/openings/` owns list filters, sorting, bulk requests, selection, keyboard/range interaction and age controls. `OpeningBulkActions.tsx` and `opening-preparation-targets.ts` own full/answers-only targeting rules; `OpeningFormActions.tsx` and `FormQuestionCount.tsx` render question controls. Skill grouping/matching/fitting and styles live under `skills/`.

`openings/research/` owns paragraphs, bullets and source-backed display. `OpeningWorkflow.tsx` owns material controls; `openings/autofill/` owns script views, history/activity loading and tab handoff. `OpeningPostingLink.tsx` uses verified application navigation. `pull-guidance/` owns captured condition editing and prompt preview; `pull-metrics/` owns lazy metrics views. Dismissal, questions, application details and company contact copying remain distinct actions.

`client/preparation/` owns activity polling, formatting, request wording, material warnings and bounded transition notices. `client/applications/` owns stage visibility, details, saved packages and follow-up email views. `client/gmail/` owns connection and reply attention without duplicate polling owners.

`client/settings/` owns section shells/navigation, workflow settings, models, tunables, appearance and records/activity. `SettingsSection` mounts collapsed content only when expanded. `client/questions/` owns message-model choice; `client/app-reload/` owns reload queue/status and hidden-tab polling behavior.

`client/ui/` has one named primitive per component, including accessible `InfoTooltip`, real-URL `AppLink`, rich text, date display, copying and selection. `PdfPreview.tsx` retains lazy loading of `PdfViewer.tsx`. `client/styles.css` is import-only; named sheets own features and responsive layers. `check:client-structure` checks root allowlists, ownership and theme literals. Component DOM baselines must remain unchanged for behavior-identical refactors.

### Tooling and fixtures

`platform/scripts/run-locked.mjs` and `process-group.mjs` own named test locks, liveness and bounded cleanup. Stop only your own process group; never broad-match kill another session's tests. `worktree.sh` owns isolated worktree creation/landing. `check.mjs` runs the complete offline suite; `check-backend-layout.mjs` reads the Contracts table below.

`app/tests/fixtures/` owns reusable synthetic stores, documents, model transports and HTTP workspaces. Native tests remain distinct from synthetic persistence tests. `app/scripts/browser-refactor-fixture.ts` builds disposable browser data; screenshots and browser acceptance must use synthetic content without transmitting data to real forms. Performance measurement scripts under `platform/scripts/` use isolated child workspaces and never a live database.

`platform/sample-workspace/` is the synthetic workspace root (fictional applicant, companies, resume master `source_master_template/v1/` with its real renderer, dossier, reference letter, careers data and the writing guidelines in its own AGENTS.md). Tests copy it through `app/tests/fixtures/sample-workspace.ts`, `dev:server` seeds from it without overwriting sandbox edits, and `verify:release` copies it into a disposable root when `JOB_SEARCH_ROOT` is unset. The workspace `source_data/README.md` names the current general master and any current tailored master (`employer_specific/<slug>/`); an employer README's `Private files:` line declares which files are private, and undeclared tailored directories stay drafts. Deployment publishes sources only from an explicit `FIELDWORK_WORKSPACE_ROOT` (`platform/deploy/sync-sources.sh`); without it a deploy is code-only, and the contributor AGENTS.md is never published as workspace writing rules. `app/shared/workspace-sources.ts` declares the canonical source paths (general resume Markdown, dossier, reference letter Markdown/PDF, source README) that evidence, bundles, promotion, question context and autofill read.

## Contracts

| Path | Caller | Owner |
|---|---|---|
| `platform/app/server/index.ts` | npm start/serve/dev, cloud systemd and Mac launchd | `platform/app/server/workspace-entry.ts` |
| `platform/app/scripts/deploy-preview.ts` | npm deploy:preview, local-only client publication | `platform/app/scripts/preview-deployment.ts` |
| `platform/app/scripts/service.ts` | npm service lifecycle verbs and installed Mac job management | `platform/app/scripts/service.ts` |
| `platform/app/scripts/stop.ts` | npm stop, explicit foreground shutdown | `platform/app/scripts/stop.ts` |
| `platform/app/scripts/import.ts` | npm import, explicit source import | `platform/app/server/importer.ts` |
| `platform/app/scripts/backup.ts` | npm backup, operator backup export | `platform/app/server/backup-archive.ts` |
| `platform/app/scripts/backup-verify.ts` | npm backup:verify, offline archive verification | `platform/app/server/backup-verify.ts` |
| `platform/app/scripts/probe-codex.ts` | npm verify:codex, opt-in live agent probe | `platform/app/scripts/probe-codex.ts` |
| `platform/app/scripts/verify-release.ts` | npm verify:release and complete offline check | `platform/app/scripts/verify-release.ts` |
| `platform/app/scripts/browser-check.ts` | npm verify:browser, documented clean-browser acceptance | `platform/app/scripts/browser-check.ts` |
| `platform/app/scripts/browser-refactor-fixture.ts` | npm fixture:browser-refactor, isolated populated data | `platform/app/scripts/browser-refactor-fixture.ts` |
| `platform/app/scripts/generate-helper-contract.ts` | npm helpers:generate, packaged Greenhouse helper contract | `platform/app/scripts/helper-contract.ts` |
| `platform/deploy/live.sh` | npm deploy, production release of `origin/main` or `--ref` from a detached worktree: full check, deploy.sh with source push, queueing lock, `--background` | `platform/deploy/live.sh` |
| `platform/app/scripts/dev-client.ts` | npm dev:client, per-session hot-reload client preview | `platform/app/scripts/dev-client.ts` |
| `platform/app/scripts/dev-server.ts` | npm dev:server, disposable local backend on fixture data | `platform/app/scripts/dev-server.ts` |
| `platform/app/scripts/demo.ts` | npm demo, isolated synthetic showcase | `platform/app/scripts/demo-runtime.ts` |
| `platform/app/scripts/demo-screenshots.ts` | npm demo:screenshots, isolated clean-browser capture | `platform/app/scripts/demo-capture.ts` |
| `platform/scripts/run-locked.mjs` | npm test:native and check, named queueing lock | `platform/scripts/run-locked.mjs` |
| `platform/scripts/worktree.sh` | npm worktree, session worktree new/land/list | `platform/scripts/worktree.sh` |
| `platform/scripts/check-client-structure.mjs` | npm check:client-structure and build | `platform/scripts/check-client-structure.mjs` |
| `platform/scripts/check-backend-layout.mjs` | npm check:backend-layout and npm test | `platform/scripts/check-backend-layout.mjs` |
| `platform/scripts/check.mjs` | npm check, complete offline suite | `platform/scripts/check.mjs` |
