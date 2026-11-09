import type { RecordLink } from "../../../shared/record-catalog";
import AppLink from "../../ui/AppLink";
import type { Go } from "../../workspace/workspace-actions";

// Runs without their own detail route stay text rather than linking to an unrelated page.
const recordPages: Readonly<Record<string, string>> = {
  application: "applications", company: "companies", document: "documents", opening: "openings", task: "agents",
};

export function RecordEntityLink({ record, go }: { record: RecordLink; go: Go }) {
  const page = recordPages[record.kind];
  return page ? <AppLink go={go} page={page} id={record.id}>{record.title}</AppLink> : <span>{record.title}</span>;
}
