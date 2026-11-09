import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Trash2 } from "lucide-react";
import type { DeletionKind, DeletionPreview } from "../../shared/record-deletion";
import { api } from "../workspace/api";
import { useOptionalWorkspace } from "../workspace/workspace";

export default function DeleteRecord({kind,id,label,title,onDeleted}: {kind:DeletionKind;id:string;label:string;title?:string;onDeleted?:()=>void}) {
  const workspace=useOptionalWorkspace();
  const notify=workspace?.notify ?? (()=>{});
  const [open,setOpen]=useState(false),[preview,setPreview]=useState<DeletionPreview>(),[error,setError]=useState(""),[busy,setBusy]=useState(false),[check,setCheck]=useState(0);
  const dialog=useRef<HTMLDialogElement>(null);
  const endpoint=`/api/records/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`;
  const blockedBy=preview?.blockedBy??[];
  useEffect(()=>{
    if(!open)return;
    dialog.current?.showModal();
    setPreview(undefined);setError("");
  },[open,endpoint]);
  useEffect(()=>{
    if(!open)return;
    let live=true;
    api(`${endpoint}/deletion`).then(p=>{if(live)setPreview(p);}).catch(e=>{if(live)setError(e.message);});
    return ()=>{live=false;};
  },[open,endpoint,check]);
  // Blocking work used to leave a dead dialog; recheck until it finishes.
  useEffect(()=>{
    if(!open||!blockedBy.length)return;
    const timer=setTimeout(()=>setCheck(n=>n+1),5000);
    return ()=>clearTimeout(timer);
  },[open,preview]);
  async function remove(){
    if(!preview)return;
    setBusy(true);setError("");
    // The server's change event refreshes state independently of this completed write.
    try {await api(endpoint,{token:preview.token},"DELETE");}
    catch(e){setError(e instanceof Error?e.message:String(e));setPreview(undefined);setBusy(false);setCheck(n=>n+1);return;}
    setBusy(false);setOpen(false);notify(`Deleted ${label}`);onDeleted?.();
  }
  return <>
    <button type="button" className="icon-button delete-record" aria-label={`Delete ${label}`} title={title??`Delete ${label}`} onClick={e=>{e.preventDefault();e.stopPropagation();setOpen(true);}}><Trash2 size={15} aria-hidden="true" /></button>
    {open&&createPortal(<dialog ref={dialog} className="delete-record-dialog" aria-label={`Permanently delete ${label}`} onCancel={e=>{if(busy)e.preventDefault();else setOpen(false);}} onClose={()=>setOpen(false)}>
      <h2>Permanently delete {label}?</h2>
      {error&&<p className="error-text" role="alert">{error}</p>}
      {!preview&&!error&&<p role="status">Checking related records and files…</p>}
      {preview&&<>
        <p>This removes {preview.records.length} record{preview.records.length===1?"":"s"}, {preview.files.length} file{preview.files.length===1?"":"s"}, and updates {preview.editedFiles.length} source file{preview.editedFiles.length===1?"":"s"}. This cannot be undone in Fieldwork.</p>
        <details><summary>Review everything being deleted</summary><ul>{preview.records.map(r=><li key={`${r.kind}:${r.id}`}>{r.title} <span className="muted">({r.kind.replaceAll("_"," ")})</span></li>)}</ul>{!!preview.files.length&&<ul>{preview.files.map(f=><li key={f}>{f}</li>)}</ul>}</details>
        {!!preview.editedFiles.length&&<details><summary>Source files being updated</summary><ul>{preview.editedFiles.map(f=><li key={f}>{f}</li>)}</ul></details>}
        <details><summary>Related records being updated ({preview.updatedRecords.length})</summary><ul>{preview.updatedRecords.map(r=><li key={`${r.kind}:${r.id}`}>{r.title} ({r.kind.replaceAll("_"," ")})</li>)}</ul></details><p className="small muted">Shared files used by remaining records are kept. Existing external backups and Git history are not rewritten.</p>
        {!!blockedBy.length&&<p className="warning-text" role="status">Waiting for this work to finish (or pause it): {blockedBy.join(", ")}. Delete unlocks on its own.</p>}
      </>}
      <div className="row-wrap"><button type="button" className="button secondary" disabled={busy} onClick={()=>setOpen(false)}>Cancel</button><button type="button" className="button danger" disabled={!preview||!!blockedBy.length||busy} onClick={()=>void remove()}>{busy?"Deleting…":"Permanently delete"}</button></div>
    </dialog>,document.body)}
  </>;
}
