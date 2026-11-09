import React from "react";
import { FolderOpen } from "lucide-react";

export function Empty({
  icon: Icon = FolderOpen,
  title,
  children,
  loading = false,
}: {
  icon?: any;
  loading?: boolean;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <Icon size={30} strokeWidth={1.4} className={loading ? "spin" : undefined} />
      <h3>{title}</h3>
      <div>{children}</div>
    </div>
  );
}
