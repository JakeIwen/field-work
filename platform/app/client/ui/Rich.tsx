import React from "react";
import { ExternalLink } from "lucide-react";
import { richTextParts } from "./rich-text";

export function Rich({ text = "" }: { text?: string }) {
  const parts = richTextParts(text);
  return (
    <>
      {parts.map((part, i) => {
        const m = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        const href = m?.[2] || (/^https?:/.test(part) ? part : "");
        return /^https?:\/\//.test(href) ? (
          <a key={i} href={href} target="_blank" rel="noreferrer">
            {m?.[1] || part}
            <ExternalLink size={11} className="inline-icon" />
          </a>
        ) : (
          <React.Fragment key={i}>
            {part.replace(/\*\*([^*]+)\*\*/g, "$1")}
          </React.Fragment>
        );
      })}
    </>
  );
}
