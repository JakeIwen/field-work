import { RefreshCw, Wrench } from "lucide-react";
import type { RescanProgress } from "../../shared/rescan-progress";

export type MaintenanceProps = {
  onRescan: () => void;
  disabled: boolean;
  rescanning: boolean;
  progress: RescanProgress | null;
};

/** The Rescan files card in the Settings page's Workspace section. */
export default function Maintenance({ onRescan, disabled, rescanning, progress }: MaintenanceProps) {
  return <section className="settings-tool" aria-labelledby="maintenance-heading">
    <h3 id="maintenance-heading"><Wrench size={15} aria-hidden="true" /> Maintenance</h3>
    <button type="button" className="button secondary" disabled={disabled} onClick={onRescan}
      title="Reindex research and document files. Does not check employer websites.">
      <RefreshCw size={15} className={rescanning ? "spin" : ""} aria-hidden="true" />
      {rescanning ? progress?.total ? `Rescanning ${progress.completed ?? 0}/${progress.total}` : "Rescanning files…" : "Rescan files"}
    </button>
  </section>;
}
