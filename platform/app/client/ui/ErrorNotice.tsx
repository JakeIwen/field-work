import "./error-notice.css";

export function errorSummary(error: string, fallback = "Something went wrong. Open error details for more information.") {
  const overflow = [...error.matchAll(/Page (\d+) overflowed(?: by (\d*\.?\d+(?:e[+-]?\d+)?) points)?/gi)].at(-1);
  if (overflow) {
    const amount = overflow[2] ? ` by ${Number(Number(overflow[2]).toFixed(2))} points` : "";
    const shortening = /Automatic shortening stopped after (\d+) attempts/i.exec(error);
    return shortening
      ? `The resume PDF could not be generated: page ${overflow[1]} was still too long${amount} after ${shortening[1]} automatic shortening attempts.`
      : `The resume PDF could not be generated because page ${overflow[1]} is too long${amount}.`;
  }
  if (error.length <= 240 && !/Command failed|Stack dump|Fatal error|\bat .+\(.+:\d+|\/Users\/|\/Applications\/|\n\s*\d+\./i.test(error))
    return error.trim();
  return fallback;
}

export default function ErrorNotice({ error, fallback, preserveContext = false }: { error: string; fallback?: string; preserveContext?: boolean }) {
  const brief = errorSummary(error, fallback);
  const context = preserveContext && brief !== error.trim() ? /^([^:\n]{1,200} · [^:\n]{1,200}):/.exec(error)?.[1] : undefined;
  const summary = context ? `${context}: ${brief}` : brief;
  return <div className="error-notice">
    <p role="alert" className="error-text">{summary}</p>
    {summary !== error.trim() && <details key={error} className="error-details">
      <summary>Error details</summary>
      <pre tabIndex={0} aria-label="Full error message">{error}</pre>
    </details>}
  </div>;
}
