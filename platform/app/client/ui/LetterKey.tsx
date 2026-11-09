import "./letter-picker.css";

export type LetterKeyEntry = { letter: string; label: string; group?: string };

/** Explains a LetterPicker's letters: a miniature tile and its name per entry, clusters set apart. */
export default function LetterKey({ entries, label }: { entries: LetterKeyEntry[]; label?: string }) {
  return <ul className="letter-key" aria-label={label}>
    {entries.map((entry, index) => <li key={`${entry.letter}-${entry.label}`}
      className={index && entries[index - 1].group !== entry.group ? "is-new-cluster" : undefined}>
      <span className="letter-choice is-key" aria-hidden="true">{entry.letter}</span> {entry.label}
    </li>)}
  </ul>;
}
