import React from "react";

type Task = { id: string; manifest?: { paths?: string[] } };
type Props = { text: string; task?: Task };

function linkTarget(value: string, task?: Task): string | undefined {
  const target = value.trim().replace(/^<|>$/g, "");
  if (/[\u0000-\u001f\u007f]/.test(target)) return;
  const path = target.replace(/^\.\//, "");
  if (task?.manifest?.paths?.includes(path))
    return "/api/tasks/" + encodeURIComponent(task.id) + "/artifact?path=" + encodeURIComponent(path);
  if (/^https?:\/\//i.test(target) || /^mailto:/i.test(target)) return target;
}

// Render React nodes, never HTML supplied by a message.
function inline(text: string, task?: Task, depth = 0, allowLinks = true): React.ReactNode[] {
  if (depth > 16) return [text];
  const nodes: React.ReactNode[] = [];
  const token = /\\([\\\x60*{}\[\]()#+.!_>~|-])|(\x60+)([\s\S]*?)\2(?!\x60)|(!?)\[([^\]\n]+)\]\((<[^>\n]+>|(?:[^()\s]|\([^()\n]*\))+)(?:\s+"[^"\n]*")?\)|<(https?:\/\/[^>\s]+|mailto:[^>\s]+)>|(\*\*\*|___|\*\*|__|~~|\*|_)(?=\S)([\s\S]*?\S)\8|https?:\/\/[^\s<>]+/g;
  let end = 0;
  for (const match of text.matchAll(token)) {
    const at = match.index!;
    nodes.push(text.slice(end, at));
    const key = at;
    if (match[1]) nodes.push(match[1]);
    else if (match[2]) nodes.push(<code key={key}>{match[3].replace(/\n/g, " ")}</code>);
    else if (match[5] || match[7]) {
      const href = allowLinks ? linkTarget(match[6] || match[7], task) : undefined;
      const label = match[5] || match[7];
      nodes.push(href
        ? <a key={key} href={href} target="_blank" rel="noreferrer noopener">{inline(label, undefined, depth + 1, false)}</a>
        : <React.Fragment key={key}>{match[0]}</React.Fragment>);
    } else if (match[8]) {
      if (match[8].includes("_") && (/\w/.test(text[at - 1] || "") || /\w/.test(text[at + match[0].length] || ""))) {
        nodes.push(match[0]);
      } else {
        const children = inline(match[9], task, depth + 1, allowLinks);
        nodes.push(match[8].length === 3 ? <strong key={key}><em>{children}</em></strong>
          : match[8] === "~~" ? <del key={key}>{children}</del>
          : match[8].length === 2 ? <strong key={key}>{children}</strong>
          : <em key={key}>{children}</em>);
      }
    } else {
      const url = match[0].replace(/[.,;:!?]+$/, "");
      const href = allowLinks ? linkTarget(url) : undefined;
      nodes.push(href ? <a key={key} href={href} target="_blank" rel="noreferrer noopener">{url}</a> : url);
      nodes.push(match[0].slice(url.length));
    }
    end = at + match[0].length;
  }
  nodes.push(text.slice(end));
  return nodes;
}

const listItem = (line: string) => /^( {0,3})([-+*]|\d+[.)])\s+(.*)$/.exec(line);
const fence = (line: string) => /^ {0,3}(\x60{3,}|~{3,})(.*)$/.exec(line);
const rule = (line: string) => /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line);
function cells(line: string): string[] {
  const result: string[] = [];
  let cell = "", ticks = 0;
  const source = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\\" && source[i + 1] === "|") { cell += "|"; i++; continue; }
    if (source[i] === "\x60") {
      let count = 1;
      while (source[i + count] === "\x60") count++;
      ticks = ticks === count ? 0 : ticks || count;
      cell += source.slice(i, i + count); i += count - 1;
    } else if (source[i] === "|" && !ticks) { result.push(cell.trim()); cell = ""; }
    else cell += source[i];
  }
  result.push(cell.trim());
  return result;
}
const tableDivider = (line: string) => line.includes("|") && cells(line).every(cell => /^:?-{3,}:?$/.test(cell));

function blocks(lines: string[], task?: Task, depth = 0): React.ReactNode[] {
  if (depth > 16) return [<p key="fallback">{lines.join("\n")}</p>];
  const result: React.ReactNode[] = [];
  const startsBlock = (i: number) => {
    const line = lines[i] || "";
    return !line.trim() || fence(line) || /^ {0,3}#{1,6}\s/.test(line) ||
      /^ {0,3}>/.test(line) || rule(line) || listItem(line) ||
      (line.includes("|") && tableDivider(lines[i + 1] || ""));
  };
  for (let i = 0; i < lines.length;) {
    const key = i, line = lines[i];
    if (!line.trim()) { i++; continue; }
    const opening = fence(line);
    if (opening) {
      const code: string[] = [];
      i++;
      const closing = new RegExp("^ {0,3}" + opening[1][0] + "{" + opening[1].length + ",}\\s*$");
      while (i < lines.length && !closing.test(lines[i])) code.push(lines[i++]);
      if (i < lines.length) i++;
      const language = opening[2].trim().split(/\s+/)[0];
      result.push(<pre key={key} tabIndex={0} aria-label={language ? language + " code" : "Code block"}><code>{code.join("\n")}</code></pre>);
      continue;
    }
    const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      result.push(React.createElement("h" + heading[1].length, { key }, inline(heading[2], task)));
      i++; continue;
    }
    if (rule(line)) { result.push(<hr key={key} />); i++; continue; }
    if (i + 1 < lines.length && /^ {0,3}(=+|-+)\s*$/.test(lines[i + 1])) {
      result.push(React.createElement(lines[i + 1].trim()[0] === "=" ? "h1" : "h2", { key }, inline(line, task)));
      i += 2; continue;
    }
    if (/^ {0,3}>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i])) quote.push(lines[i++].replace(/^ {0,3}> ?/, ""));
      result.push(<blockquote key={key}>{blocks(quote, task, depth + 1)}</blockquote>);
      continue;
    }
    if (line.includes("|") && tableDivider(lines[i + 1] || "")) {
      const headers = cells(line), dividers = cells(lines[i + 1]);
      const alignment = (index: number): React.CSSProperties => ({
        textAlign: dividers[index]?.endsWith(":") ? (dividers[index]?.startsWith(":") ? "center" : "right") : "left",
      });
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes("|") && !startsBlock(i)) rows.push(cells(lines[i++]));
      result.push(<div key={key} className="markdown-table" role="region" aria-label="Response table" tabIndex={0}>
        <table><thead><tr>{headers.map((cell, j) => <th key={j} scope="col" style={alignment(j)}>{inline(cell, task)}</th>)}</tr></thead>
          <tbody>{rows.map((row, r) => <tr key={r}>{headers.map((_, j) => <td key={j} style={alignment(j)}>{inline(row[j] || "", task)}</td>)}</tr>)}</tbody>
        </table>
      </div>);
      continue;
    }
    const first = listItem(line);
    if (first) {
      const ordered = /^\d/.test(first[2]), indent = first[1].length;
      const items: React.ReactNode[] = [];
      while (i < lines.length) {
        const item = listItem(lines[i]);
        if (!item || item[1].length !== indent || /^\d/.test(item[2]) !== ordered) break;
        const itemKey = i, padding = item[0].length - item[3].length;
        const body = [item[3]];
        i++;
        while (i < lines.length) {
          if (!lines[i].trim()) {
            let next = i + 1;
            while (next < lines.length && !lines[next].trim()) next++;
            if (next < lines.length && lines[next].match(/^ */)![0].length >= padding) { body.push(""); i++; continue; }
            i = next; break;
          }
          const spaces = lines[i].match(/^ */)![0].length;
          if (spaces >= padding) { body.push(lines[i++].slice(padding)); continue; }
          if (startsBlock(i)) break;
          body.push(lines[i++]);
        }
        const check = /^\[([ xX])\]\s+/.exec(body[0]);
        if (check) body[0] = body[0].slice(check[0].length);
        items.push(<li key={itemKey} className={check ? "markdown-task" : undefined}>
          {check && <input type="checkbox" checked={check[1] !== " "} disabled aria-label={check[1] === " " ? "Incomplete" : "Complete"} />}
          <div className="markdown-list-content">{blocks(body, task, depth + 1)}</div>
        </li>);
      }
      result.push(ordered ? <ol key={key} start={parseInt(first[2], 10)}>{items}</ol> : <ul key={key}>{items}</ul>);
      continue;
    }
    const paragraph = [line]; i++;
    while (i < lines.length && !startsBlock(i)) {
      if (/^ {0,3}(=+|-+)\s*$/.test(lines[i + 1] || "")) break;
      paragraph.push(lines[i++]);
    }
    result.push(<p key={key}>{paragraph.map((part, j) => <React.Fragment key={j}>
      {inline(part.replace(/ {2,}$|\\$/, ""), task)}{j < paragraph.length - 1 && (/ {2,}$|\\$/.test(part) ? <br /> : "\n")}
    </React.Fragment>)}</p>);
  }
  return result;
}

export default function Markdown({ text, task }: Props) {
  return <div className="chat-text markdown">{blocks(text.replace(/\r\n?/g, "\n").split("\n"), task)}</div>;
}
