import { randomBytes } from "node:crypto";
import { HttpError } from "../storage.js";
import { isFollowUpAddress } from "../../shared/follow-up-email.js";
import { plainTextHtml } from "../email-html.js";

/**
 * Email encoding for Gmail's raw send API, and the inverse parser used to
 * check Gmail's stored copy. A message is multipart/alternative: the plain
 * text as written, then the HTML rendered from it, which mail apps prefer
 * because it comes last. Both parts are UTF-8 in base64 so no character,
 * line length or leading dot can be altered in transit.
 */
export type OutgoingEmail = {
  from?: { email: string; name?: string };
  to: string;
  subject: string;
  body: string;
};
export type ParsedEmail = {
  subject: string;
  to: string;
  from: string;
  text: string;
  /** The HTML part, when the copy has one. */
  html?: string;
  /** How many parts of each type the copy has; ours has one of each. */
  versions: { plain: number; html: number };
};

const ascii = (value: string) => /^[\x20-\x7e]*$/.test(value);
const hasControl = (value: string) => /[\0-\x1f\x7f]/.test(value);

/** RFC 2047 encoded words of at most 75 characters, never splitting a character's UTF-8 bytes. */
export function encodeHeaderWords(value: string) {
  const words: string[] = [];
  let chunk = "";
  const fits = (text: string) =>
    `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`.length <= 75;
  for (const char of value) {
    if (fits(chunk + char)) chunk += char;
    else {
      words.push(chunk);
      chunk = char;
    }
  }
  if (chunk || !words.length) words.push(chunk);
  return words.map(
    (word) => `=?UTF-8?B?${Buffer.from(word, "utf8").toString("base64")}?=`,
  );
}

function headerText(value: string) {
  return ascii(value) && !/=\?/.test(value) && value.length <= 900
    ? value
    : encodeHeaderWords(value).join("\r\n ");
}

function quotedName(name: string) {
  if (ascii(name)) return `"${name.replace(/(["\\])/g, "\\$1")}"`;
  return encodeHeaderWords(name).join("\r\n ");
}

const wrap = (value: string, width: number) =>
  value.match(new RegExp(`.{1,${width}}`, "g"))?.join("\r\n") ?? "";

const base64Part = (type: string, content: string) =>
  [
    `Content-Type: ${type}; charset="UTF-8"`,
    "Content-Transfer-Encoding: base64",
    "",
    wrap(Buffer.from(content, "utf8").toString("base64"), 76),
  ].join("\r\n");

export function buildRawEmail(email: OutgoingEmail) {
  if (!isFollowUpAddress(email.to))
    throw new HttpError(400, "Enter one valid recipient email address.");
  if (email.from && !isFollowUpAddress(email.from.email))
    throw new HttpError(502, "Gmail returned an unusable sender address.");
  if (!email.subject.trim() || hasControl(email.subject))
    throw new HttpError(400, "Write a one-line subject before sending.");
  if (!email.body.trim())
    throw new HttpError(400, "Write the email before sending.");
  const body = email.body.replace(/\r\n?/g, "\n").replace(/\n/g, "\r\n");
  // Base64 lines never contain "-", so no part can contain the delimiter.
  const boundary = `fieldwork-alt-${randomBytes(12).toString("hex")}`;
  const from = email.from
    ? email.from.name && !hasControl(email.from.name)
      ? `From: ${quotedName(email.from.name)} <${email.from.email}>`
      : `From: ${email.from.email}`
    : undefined;
  const headers = [
    ...(from ? [from] : []),
    `To: ${email.to}`,
    `Subject: ${headerText(email.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    `X-Fieldwork-Send: ${randomBytes(6).toString("hex")}`,
  ];
  return [
    headers.join("\r\n"),
    "",
    `--${boundary}`,
    base64Part("text/plain", body),
    `--${boundary}`,
    base64Part("text/html", plainTextHtml(email.body)),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

function splitMessage(raw: Buffer) {
  const text = raw.toString("latin1");
  const match = /\r?\n\r?\n/.exec(text);
  if (!match) return { head: text, body: Buffer.alloc(0) };
  return {
    head: text.slice(0, match.index),
    body: raw.subarray(match.index + match[0].length),
  };
}

function parseHeaders(head: string) {
  const headers = new Map<string, string[]>();
  let current = "";
  const flush = () => {
    const index = current.indexOf(":");
    if (index > 0) {
      const name = current.slice(0, index).trim().toLowerCase();
      headers.set(name, [
        ...(headers.get(name) ?? []),
        current.slice(index + 1).trim(),
      ]);
    }
  };
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line)) current += line;
    else {
      flush();
      current = line;
    }
  }
  flush();
  return headers;
}

function decodeBytes(bytes: Buffer, charset: string) {
  try {
    // A leading U+FEFF is content the sender typed, not a byte-order mark to drop.
    return new TextDecoder(charset || "utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
  } catch {
    throw new HttpError(
      502,
      `Gmail's sent copy could not be decoded as ${charset || "UTF-8"}.`,
    );
  }
}

function decodeQuotedPrintable(value: Buffer) {
  const text = value.toString("latin1").replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const hex = text.slice(i + 1, i + 3);
    if (text[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else bytes.push(text.charCodeAt(i));
  }
  return Buffer.from(bytes);
}

/** Decode RFC 2047 words; whitespace between adjacent encoded words is not content. */
export function decodeHeaderWords(value: string) {
  return value
    .replace(/(\?=)\s+(?==\?)/g, "$1")
    .replace(
      /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
      (_word, charset: string, encoding: string, data: string) =>
        decodeBytes(
          encoding.toUpperCase() === "B"
            ? Buffer.from(data, "base64")
            : decodeQuotedPrintable(
                Buffer.from(data.replace(/_/g, " "), "latin1"),
              ),
          charset.toLowerCase(),
        ),
    );
}

function parameter(header: string, name: string) {
  const match = new RegExp(
    `;\\s*${name}\\s*=\\s*("([^"]*)"|[^;\\s]+)`,
    "i",
  ).exec(header);
  return match ? (match[2] ?? match[1]) : "";
}

type BodyType = "text/plain" | "text/html";

/** Every part of the given type in order, searching nested multiparts. */
function bodyParts(raw: Buffer, wanted: BodyType, depth = 0): string[] {
  if (depth > 8) return [];
  const { head, body } = splitMessage(raw);
  const headers = parseHeaders(head);
  const type = headers.get("content-type")?.[0] ?? "text/plain";
  if (/^multipart\//i.test(type)) {
    const boundary = parameter(type, "boundary");
    if (!boundary) return [];
    // The line break before each delimiter belongs to the delimiter, not the part (RFC 2046 §5.1.1).
    const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const parts = `\r\n${body.toString("latin1")}`
      .split(new RegExp(`\\r?\\n--${escaped}`))
      .slice(1);
    const found: string[] = [];
    for (const part of parts) {
      if (part.startsWith("--")) break;
      found.push(
        ...bodyParts(
          Buffer.from(part.replace(/^[ \t]*\r?\n/, ""), "latin1"),
          wanted,
          depth + 1,
        ),
      );
    }
    return found;
  }
  if (type.split(";")[0].trim().toLowerCase() !== wanted) return [];
  const encoding = (
    headers.get("content-transfer-encoding")?.[0] ?? "7bit"
  ).toLowerCase();
  const bytes =
    encoding === "base64"
      ? Buffer.from(body.toString("latin1").replace(/\s+/g, ""), "base64")
      : encoding === "quoted-printable"
        ? decodeQuotedPrintable(body)
        : body;
  return [decodeBytes(bytes, parameter(type, "charset").toLowerCase())];
}

/** The addr-spec of each mailbox in an address header ("Name <a@b>, c@d"). */
export function mailboxAddresses(header: string) {
  return header
    .replace(/"(?:[^"\\]|\\.)*"/g, "")
    .split(",")
    .map((mailbox) => (/<([^>]*)>/.exec(mailbox)?.[1] ?? mailbox).trim())
    .filter(Boolean);
}

export function parseRawEmail(raw: Buffer): ParsedEmail {
  const headers = parseHeaders(splitMessage(raw).head);
  const header = (name: string) =>
    decodeHeaderWords(headers.get(name)?.[0] ?? "");
  const texts = bodyParts(raw, "text/plain");
  if (!texts.length)
    throw new HttpError(502, "Gmail's sent copy has no plain-text body.");
  const htmls = bodyParts(raw, "text/html");
  // A mail app shows the last alternative it can display.
  const html = htmls.at(-1);
  return {
    subject: header("subject"),
    to: header("to"),
    from: header("from"),
    // The encoder ends the base64 block with CRLF; the body itself never gains a newline.
    text: texts.at(-1)!.replace(/\r\n?/g, "\n"),
    ...(html === undefined ? {} : { html: html.replace(/\r\n?/g, "\n") }),
    versions: { plain: texts.length, html: htmls.length },
  };
}
