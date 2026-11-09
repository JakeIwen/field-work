import { Link2 } from "lucide-react";
import { formatDate } from "./dates";

export function Source({ path, date }: { path: string; date?: string | null }) {
  return (
    <div className="source">
      <Link2 size={13} />
      <a
        href={`/api/source?path=${encodeURIComponent(path)}`}
        target="_blank"
        rel="noreferrer"
      >
        {path}
      </a>
      {date && <span>· {formatDate(date)}</span>}
    </div>
  );
}
