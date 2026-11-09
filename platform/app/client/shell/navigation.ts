import {
  Bot,
  BriefcaseBusiness,
  Building2,
  CircleHelp,
  FileText,
  FolderOpen,
  LayoutDashboard,
  Mail,
  RefreshCw,
} from "lucide-react";

// "actions" marks routes whose header shows Validate openings.
export const pages = [
  ["overview", "Overview", LayoutDashboard, ""],
  ["openings", "Openings", BriefcaseBusiness, "actions"],
  ["scans", "Careers scans", RefreshCw, ""],
  ["companies", "Companies", Building2, ""],
  ["applications", "Applications", FolderOpen, ""],
  ["replies", "Employer replies", Mail, ""],
  ["documents", "Documents", FileText, ""],
  ["questions", "Questions", CircleHelp, ""],
  ["agents", "Agent workspace", Bot, ""],
] as const;

// Second key after "g" (within one second) and its destination.
export const goKeys: Record<string, [string, string]> = {
  o: ["openings", "Openings"],
  a: ["applications", "Applications"],
  c: ["companies", "Companies"],
  v: ["overview", "Overview"],
  s: ["scans", "Careers scans"],
};

export const shortcutHelp: [string, string][] = [
  ["/", "Search the workspace"],
  ...Object.entries(goKeys).map(
    ([key, [, label]]) => [`g then ${key}`, `Go to ${label}`] as [string, string],
  ),
  ["?", "Show keyboard shortcuts"],
  ["Esc", "Close this dialog or a notification"],
];

export const openingListHelp: [string, string][] = [
  ["↓ / ↑ or j / k", "Next / previous opening"],
  ["Enter / o", "Open the selected opening"],
  ["x", "Select or deselect it for bulk actions"],
  ["Shift-click", "Select or clear a range of opening checkboxes"],
  ["Esc", "Close the comparison, then the detail"],
];

export type PageEntry = (typeof pages)[number];
