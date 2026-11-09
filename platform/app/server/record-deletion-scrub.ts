type DeletionReferenceIds = {
  companyIds: Set<string>;
  openingIds: Set<string>;
  documentIds: Set<string>;
  applicationIds: Set<string>;
  allIds: Set<string>;
};

/** Capture identities only, never the selected rows and their histories. Returning
 * unchanged subtrees also avoids serializing large unrelated text to detect edits. */
export function deletionReferenceScrubber({
  companyIds,
  openingIds,
  documentIds,
  applicationIds,
  allIds,
}: DeletionReferenceIds) {
  function scrub(value: any): any {
    if (Array.isArray(value)) {
      const result = value.flatMap((entry) => {
        if (typeof entry === "string" && allIds.has(entry)) return [];
        const after = scrub(entry);
        return after === undefined ? [] : [after];
      });
      return result.length === value.length &&
        result.every((entry, i) => entry === value[i])
        ? value
        : result;
    }
    if (!value || typeof value !== "object") return value;
    if (
      (value.company_id && companyIds.has(value.company_id)) ||
      (value.company_id &&
        value.job_id &&
        openingIds.has(`${value.company_id}:${value.job_id}`)) ||
      documentIds.has(value.id) ||
      applicationIds.has(value.applicationId) ||
      openingIds.has(value.openingId)
    )
      return undefined;
    let result: Record<string, unknown> | undefined;
    for (const [key, entry] of Object.entries(value)) {
      const remove =
        allIds.has(key) ||
        (typeof entry === "string" &&
          /^(?:taskId|scriptId|preparationId|documentId|generatedBy|bundleId)$/.test(
            key,
          ) &&
          allIds.has(entry));
      const after = remove ? undefined : scrub(entry);
      if (after === entry && !remove) continue;
      const changed: Record<string, unknown> = result ?? { ...value };
      result = changed;
      if (after === undefined) delete changed[key];
      // A JSON key named __proto__ remains data, never a prototype assignment.
      else
        Object.defineProperty(changed, key, {
          value: after,
          enumerable: true,
          writable: true,
          configurable: true,
        });
    }
    return result ?? value;
  }
  return scrub;
}
