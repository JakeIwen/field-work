import { useRef, type KeyboardEvent } from "react";
import "./letter-picker.css";

export type LetterOption = {
  id: string;
  /** The visible tile text; one character selects by typing, longer text ("Auto") is click-only. */
  letter: string;
  /** Accessible name and tooltip. */
  label: string;
  disabled?: boolean;
  /** Consecutive options with different groups form separate clusters. */
  group?: string;
  /** A dot under the letter; the label says why. */
  marker?: "default";
  /** Shown but not selectable, for a saved value the catalog no longer offers. */
  unavailable?: boolean;
};

type Props = {
  label: string;
  value: string;
  onChange: (id: string) => void;
  options: LetterOption[];
  disabled?: boolean;
  size?: "compact";
  id?: string;
};

const selectable = (option: LetterOption) => !option.disabled;

const clusters = (options: LetterOption[]) =>
  options.reduce<LetterOption[][]>((all, option, index) => {
    if (index && options[index - 1].group === option.group) all[all.length - 1].push(option);
    else all.push([option]);
    return all;
  }, []);

/** A segmented radio group whose tiles show letters: one click, an arrow key or the typed letter chooses. */
export default function LetterPicker({ label, value, onChange, options, disabled = false, size, id }: Props) {
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const checkedIndex = options.findIndex(option => option.id === value);
  const tabbable = checkedIndex >= 0 && selectable(options[checkedIndex]) ? checkedIndex : options.findIndex(selectable);
  const choose = (option: LetterOption | undefined) => {
    if (!option || disabled) return;
    buttons.current.get(option.id)?.focus();
    if (option.id !== value) onChange(option.id);
  };
  const step = (from: number, direction: 1 | -1) => {
    for (let offset = 1; offset <= options.length; offset++) {
      const candidate = options[(((from + direction * offset) % options.length) + options.length) % options.length];
      if (selectable(candidate)) return candidate;
    }
    return undefined;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || event.ctrlKey || event.metaKey || event.altKey) return;
    const focused = options.findIndex(option => buttons.current.get(option.id) === document.activeElement);
    const from = focused >= 0 ? focused : Math.max(checkedIndex, 0);
    let next: LetterOption | undefined;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = step(from, -1);
    else if (event.key === "ArrowRight" || event.key === "ArrowDown") next = step(from, 1);
    else if (event.key === "Home") next = options.find(selectable);
    else if (event.key === "End") next = [...options].reverse().find(selectable);
    else if (event.key.length === 1) {
      // Shift is deliberately not a modifier here: typing an uppercase letter selects like the lowercase one.
      next = options.find(option => selectable(option) && !option.unavailable && option.letter.length === 1
        && option.letter.toLowerCase() === event.key.toLowerCase());
      // Unmatched keys (Space, Enter) keep their native button activation.
      if (!next) return;
    } else return;
    event.preventDefault();
    choose(next);
  };
  return <div id={id} className={`letter-picker${size ? ` is-${size}` : ""}`} role="radiogroup" aria-label={label} onKeyDown={onKeyDown}>
    {clusters(options).map(cluster => <span key={cluster[0].id} className="letter-cluster">
      {cluster.map(option => {
        const checked = option.id === value;
        return <button key={option.id} type="button" role="radio" aria-checked={checked} aria-label={option.label} title={option.label}
          className={`letter-choice${checked ? " is-checked" : ""}${option.marker === "default" ? " is-default" : ""}${option.unavailable ? " is-unavailable" : ""}`}
          disabled={disabled || option.disabled}
          tabIndex={options.indexOf(option) === tabbable ? 0 : -1}
          ref={node => { if (node) buttons.current.set(option.id, node); else buttons.current.delete(option.id); }}
          onClick={() => choose(option)}>{option.letter}</button>;
      })}
    </span>)}
  </div>;
}
