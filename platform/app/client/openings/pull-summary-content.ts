export const pullCountDefinitions = [
  ["Discovered", "Unique posting records found in this pull, including those already saved or screened out. The same board and posting found in several searches counts once."],
  ["Researched", "Agent reviews whose decisions have been processed in this pull, not reviews still running or waiting to save. Their outcomes also count as added, already saved, excluded or deferred."],
  ["Already saved", "Matches an existing Fieldwork Opening, including closed or Not interested records and other advertisements of the same requisition."],
  ["Excluded", "Ruled out by title or company filters, the freshness window, C#/.NET or other excluded technologies, required travel above 5%, closed or unlisted postings, or agent checks of duties, location, employment scope or fit."],
  ["Deferred", "Not added because important evidence is unresolved, such as the original publication date or eligibility, or because a finishing review could not publish. Not automatically retried in this pull."],
  ["Remaining", "Records still queued or in review, including completed reviews waiting for their decisions to be processed. Paused or stopped work stays in this count until resolved."],
  ["Reviewed in earlier pulls", "A matching earlier agent exclusion or deferral was reused without a new review. Also counted as excluded or deferred, not as newly researched."],
  ["Added", "Saved as new Openings by this pull. Also counted as researched; already saved Openings do not increase this number."],
  ["Totals", "Added + already saved + excluded + deferred + remaining = discovered. Researched and reviewed in earlier pulls overlap those outcomes; do not add them again."],
] as const;
