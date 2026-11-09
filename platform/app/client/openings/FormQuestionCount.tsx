import type { OpeningFormQuestionCounts } from "../../shared/opening-form-check";
import InfoTooltip from "../ui/InfoTooltip";
import "./form-question-count.css";

export function FormQuestionCount({ result }: { result?: OpeningFormQuestionCounts }) {
  if (!result) return null;
  const label = `${result.personal.length} questions may need your own answer`;
  return <InfoTooltip label={label} triggerLabel={`(${result.personal.length})`} className="form-question-count">
    <p>{label}</p>
    {result.personal.length > 0 && <ul>{result.personal.map((item, index) => <li key={index}>{item.label}</li>)}</ul>}
    <p>{result.narrative} written questions a model would draft</p>
    <p>Checked from the form without a model; drafting can still flag more.</p>
  </InfoTooltip>;
}
