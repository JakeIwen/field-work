import { Rich } from "../../ui/Rich";
import { researchBullets, researchParagraphs } from "./research-paragraphs";

export default function ResearchText({ text = "" }: { text?: string }) {
  if (!text) return <span className="muted">Unknown</span>;
  return <div className="research-text">{researchParagraphs(text).map((paragraph, index) =>
    <p key={index}><Rich text={paragraph} /></p>)}
  </div>;
}

/** Fit assessments read as bullets; each source paragraph is its own list. */
export function ResearchBullets({ text = "" }: { text?: string }) {
  const groups = researchBullets(text);
  if (!groups.length) return <span className="muted">Unknown</span>;
  return <div className="research-text">{groups.map((items, index) =>
    <ul key={index} className="research-bullets">{items.map((item, itemIndex) => <li key={itemIndex}><Rich text={item} /></li>)}</ul>)}
  </div>;
}
