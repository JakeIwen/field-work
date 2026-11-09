# Reports

## Resume variant outcomes

`GET /api/reports/resume-variants` groups sent document content hashes with applications that used them and their current stages. Packages without direct documents can resolve saved autofill-script attachments. An application appears once per row, with its latest send of that document.

Unsubmitted selected documents are explicitly labeled as not submitted and have no package-sent timestamp. Generated, general-master and legacy sources remain distinguishable. Rows sort by application count and then generation date; unknown dates stay unknown.

Stages are user-recorded pipeline state, not employer confirmation. A copied autofill script does not prove employer receipt. Reports must preserve this distinction rather than converting tracking shortcuts into outcome evidence. This public snapshot includes no catalog or report generated from real applications.
