import { useId, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Trash2 } from "lucide-react";

export type TransferSide = "left" | "right";
export type TransferItem = { id: string; label: string; detail?: ReactNode; removable?: boolean; moveDisabled?: boolean };
type Pane = { title: string; items: TransferItem[]; empty: string };
type Props = {
  left: Pane; right: Pane;
  moveLabel: (item: TransferItem, to: TransferSide) => string;
  onMove: (id: string, to: TransferSide) => void;
  onRemove?: (id: string) => void;
};

export function GuidanceTransfer({ left, right, moveLabel, onMove, onRemove }: Props) {
  const identity = useId();
  const dragging = useRef<{ id: string; from: TransferSide } | null>(null);
  const [over, setOver] = useState<TransferSide | null>(null);
  function drop(to: TransferSide) {
    const item = dragging.current;
    if (item && item.from !== to) onMove(item.id, to);
    dragging.current = null; setOver(null);
  }
  function pane(side: TransferSide, data: Pane) {
    const to = side === "left" ? "right" : "left";
    return <section className="guidance-transfer-pane" aria-labelledby={`${identity}-${side}`} data-drag-over={over === side}
      onDragOver={event => { if (dragging.current && dragging.current.from !== side) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setOver(side); } }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(null); }}
      onDrop={event => { event.preventDefault(); drop(side); }}>
      <h3 id={`${identity}-${side}`}>{data.title}</h3>
      {data.items.length ? <ul className="guidance-transfer-list">{data.items.map(item => <li key={item.id} className="guidance-transfer-item" draggable={!item.moveDisabled}
        onDragStart={event => { dragging.current = { id: item.id, from: side }; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", item.label); }}
        onDragEnd={() => { dragging.current = null; setOver(null); }}>
        <span className="guidance-transfer-label">{item.label}{item.detail !== undefined && <span className="small muted"> · {item.detail}</span>}</span>
        {item.removable && <button type="button" className="icon-button" aria-label={`Delete custom term ${item.label}`} title={`Delete custom term ${item.label}`} onClick={() => onRemove?.(item.id)}><Trash2 size={16} aria-hidden="true" /></button>}
        <button type="button" className="icon-button" disabled={item.moveDisabled} aria-label={moveLabel(item, to)} title={moveLabel(item, to)} onClick={() => onMove(item.id, to)}>
          {side === "left" ? <ArrowRight size={17} aria-hidden="true" /> : <ArrowLeft size={17} aria-hidden="true" />}
        </button>
      </li>)}</ul> : <p className="small muted">{data.empty}</p>}
    </section>;
  }
  return <div className="guidance-transfer">{pane("left", left)}{pane("right", right)}</div>;
}
