# Gmail employer replies

The Gmail integration checks employer correspondence and presents evidence for review. A connected backend can schedule checks independently of an open browser. Drafting and sending follow-up emails are separate; see [Follow-up emails](follow-up-email.md).

## Connect once

Use the Desktop OAuth flow as the backend's intended account. Read, filter-settings and send permissions are distinct capabilities. Existing read credentials can remain usable while additional permissions are requested. Never store client secrets or refresh tokens in source control or application backups. With a companion, begin authorization on the connected machine so its localhost callback can relay correctly.

## Check and review behavior

The initial broad scan and scanner upgrades cover a bounded historical window; incremental scans overlap completed coverage. Archived incoming mail is eligible, without requiring a brittle keyword-only query. Versioned cursors persist bounded progress. Pagination failures preserve incomplete coverage and retry later.

Matching requires explicit, authenticated correspondence uniquely associated with an application. Receipts do not imply an interview or change stage. Ambiguous and older messages remain reviewable. Positive replies appear ahead of negative/history views. A rejection is applied only after terminal pagination and a check for newer conflicting evidence, when automatic updates are enabled.

The backend owns background scheduling and check deduplication. The client reads progress rather than launching a scan per mounted view. A collapsed section should not create a second polling owner. Errors retain coverage state and expose a recoverable reason without raw credential-bearing responses.

## Storage and operations

`app/server/gmail/manager.ts` owns scan lifecycle; `api.ts`, `auth.ts` and `send.ts` are external adapters. Matching, correlation, MIME and application update rules remain separate named modules. `app/shared/gmail.ts` owns wire vocabulary.

Reply evidence, preferences and scan cursors are backed up; OAuth tokens are excluded. Active checks participate in reload idle checks. Offline fixtures test pagination, matching and updates, but do not establish live mailbox acceptance for this snapshot.
