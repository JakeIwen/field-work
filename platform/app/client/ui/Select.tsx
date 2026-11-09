import React, { useId } from "react";

export function Select({
  label,
  value,
  onChange,
  options,
  help,
}: {
  label: string;
  value: string;
  onChange: (s: string) => void;
  options: (string | [string, string])[];
  help?: React.ReactNode;
}) {
  const id = useId();
  const optionNodes = options.map((o) =>
    typeof o === "string" ? (
      <option key={o} value={o}>
        {o}
      </option>
    ) : (
      <option key={o[0]} value={o[0]}>
        {o[1]}
      </option>
    ),
  );
  if (help)
    return (
      <div className="select-field">
        <span>
          <label htmlFor={id}>{label}</label>
          {help}
        </span>
        <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
          {optionNodes}
        </select>
      </div>
    );
  return (
    <label className="select-field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {optionNodes}
      </select>
    </label>
  );
}
