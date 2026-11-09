import React from "react";

export function Field({
  label,
  children,
}: {
  label: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div>{children || <span className="muted">Unknown</span>}</div>
    </div>
  );
}
