# Follow-up emails

Applications can draft follow-ups for sent applications in eligible stages. Drafting, editing, sending and confirming delivery are separate operations.

## Workflow

The Application pane holds recipient, subject and body fields. Edits can be saved or copied. Revision requests include current box text and retain earlier drafts for restoration. Sending requires an explicit confirmation naming recipient and account; unsaved text is saved first. The application never chooses a recipient or sends on the user's behalf without confirmation.

## Drafting

A bounded snapshot supplies writing rules, resume evidence, posting, submitted letter, dates, earlier follow-ups and employer replies. The task saves through `save_follow_up_email`. Web search may suggest only publicly sourced recruiting addresses; suggestions do not automatically fill the recipient. Saved application contacts can supply existing recipient context.

Stale conversation saves are rejected. Failed, interrupted or unaccepted requests settle visibly and permit retry instead of leaving a permanent spinner. Revisions cannot overwrite a draft other than the version they were asked to change.

## Sending and encoding

Gmail sending requires its own scope in addition to read access. Messages use UTF-8 multipart/alternative: exact plain text first, escaped/linkified HTML last. Subject encoding splits on character boundaries. After acceptance, the sender reads Gmail's raw stored copy and compares subject, text, HTML and recipient.

An in-flight marker is persisted before contacting Gmail. Clear refusals settle as failures. Timeouts, ambiguous responses or restart mid-send become uncertain and block repeats until the user checks Sent and records the outcome. User-reported delivery is not relabeled Gmail-confirmed. Test copies use the same pipeline but remain separate from actual follow-ups.

## Records

`application_follow_up` records retain draft history, generation ownership, send state and sent follow-ups. Backups and exports include them. Reload and deletion wait for in-flight sending. Sending does not change the application's stage or substitute for an employer reply.

No real email was sent to validate this public snapshot. Use isolated MIME and lifecycle fixtures before any separately authorized live acceptance.
