import type { HealthIssue } from "../../shared/types";

/** The error findings behind an incomplete Rescan files result; Store.import marks a rescan incomplete only when it records one. */
export default function RescanProblems({ issues }: { issues: HealthIssue[] }) {
  const errors = issues.filter((issue) => issue.severity === "error");
  if (!errors.length) return null;
  return <ul className="rescan-problems">
    {errors.map((issue) => <li key={issue.id}>
      {issue.message}
      {!!issue.paths?.length && <code>{issue.paths.join(", ")}</code>}
    </li>)}
  </ul>;
}
