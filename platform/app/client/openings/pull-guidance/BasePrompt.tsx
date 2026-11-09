import { useEffect, useRef, useState } from "react";
import { greenhouseReviewPromptPath, type GreenhouseReviewPrompt } from "../../../shared/greenhouse-review-prompt";
import { api } from "../../workspace/api";
import InfoTooltip from "../../ui/InfoTooltip";
import { useTextCopy } from "../../ui/useTextCopy";
import { GuidancePopup } from "./GuidancePopup";
import "./BasePrompt.css";

export function BasePrompt({ onClose }: { onClose: () => void }) {
  const [prompt, setPrompt] = useState<GreenhouseReviewPrompt | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [copyError, setCopyError] = useState("");
  const [revision, setRevision] = useState(0);
  const manualCopy = useRef<HTMLTextAreaElement>(null);
  const { copied, copy } = useTextCopy(setCopyError);
  const text = prompt?.sections.map(section => `${section.title}\n\n${section.text}`).join("\n\n") ?? "";
  useEffect(() => {
    let live = true;
    setLoading(true); setError("");
    api<GreenhouseReviewPrompt>(greenhouseReviewPromptPath)
      .then(value => { if (live) setPrompt(value); })
      .catch(cause => { if (live) setError(String(cause)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [revision]);
  useEffect(() => {
    if (copyError) { manualCopy.current?.focus(); manualCopy.current?.select(); }
  }, [copyError]);
  return <GuidancePopup title="Base prompt" onClose={onClose}>
    <div className="actions base-prompt-controls">
      <button type="button" className="button secondary" disabled={!prompt || loading} onClick={() => { setCopyError(""); void copy(text, "prompt"); }}>Copy</button>
      <InfoTooltip label="About the base prompt">The Fieldwork-authored instructions for a new review using currently saved settings, not unsaved edits or an existing pull's captured guidance. Posting values are placeholders. Files are read on demand; their instruction text is included in full. Provider-owned system prompts are not available.</InfoTooltip>
      {copied && !copyError && <span role="status">Copied</span>}
    </div>
    {loading && <p role="status">Loading base prompt…</p>}
    {error && <div><p className="intake-error" role="alert">{error}</p><button type="button" className="button secondary" onClick={() => setRevision(current => current + 1)}>Retry</button></div>}
    {copyError && <div className="base-prompt-copy">
      <p role="status">{copyError}</p>
      <textarea ref={manualCopy} aria-label="Base prompt for manual copy" readOnly rows={8} value={text} onFocus={event => event.currentTarget.select()} />
    </div>}
    {prompt?.sections.map(section => <section className="base-prompt-section" key={section.title}>
      <h3>{section.title}</h3>
      <pre>{section.text}</pre>
    </section>)}
  </GuidancePopup>;
}
