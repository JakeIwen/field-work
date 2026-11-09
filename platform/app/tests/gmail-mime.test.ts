import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRawEmail,
  decodeHeaderWords,
  encodeHeaderWords,
  parseRawEmail,
} from "../server/gmail/mime.js";
import { plainTextHtml } from "../server/email-html.js";
import { encodingProbe, encodingSubject } from "./fixtures/email-encoding.js";

test("raw email round-trips subject and body exactly, including emoji, CJK and line edge cases", () => {
  const raw = buildRawEmail({
    from: { email: "candidate@example.net", name: "Sam Rivera" },
    to: "recruiter@example.com",
    subject: encodingSubject,
    body: encodingProbe,
  });
  const parsed = parseRawEmail(Buffer.from(raw, "utf8"));
  assert.equal(parsed.subject, encodingSubject);
  assert.equal(parsed.text, encodingProbe);
  assert.equal(
    parsed.html,
    plainTextHtml(encodingProbe).replace(/\r\n/g, "\n"),
  );
  assert.equal(parsed.to, "recruiter@example.com");
  assert.equal(parsed.from, '"Sam Rivera" <candidate@example.net>');
  // The wire form is 7-bit with CRLF lines that fit RFC 5322 limits.
  assert.match(raw, /^[\x00-\x7f]*$/);
  for (const line of raw.split("\r\n")) assert.ok(line.length <= 998, line);
  assert.ok(!/(?<!\r)\n/.test(raw), "every newline is CRLF");
  const body = raw.slice(raw.indexOf("\r\n\r\n") + 4);
  for (const line of body.trim().split("\r\n")) assert.ok(line.length <= 76);
});

test("the HTML version comes last, so mail apps show it, with the plain text first as the fallback", () => {
  const raw = buildRawEmail({
    to: "a@example.com",
    subject: "Hello",
    body: "Hi <team>,\n\nOne paragraph.",
  });
  const boundary = /boundary="([^"]+)"/.exec(raw)![1];
  assert.match(
    raw,
    new RegExp(
      `\\r\\nContent-Type: multipart/alternative; boundary="${boundary}"\\r\\n`,
    ),
  );
  const types = [...raw.matchAll(/^Content-Type: (text\/\w+)/gm)].map(
    (m) => m[1],
  );
  assert.deepEqual(types, ["text/plain", "text/html"]);
  assert.ok(raw.endsWith(`\r\n--${boundary}--\r\n`));
  assert.equal(
    parseRawEmail(Buffer.from(raw)).html,
    '<div dir="ltr">Hi &lt;team&gt;,<br>\n<br>\nOne paragraph.</div>',
  );
});

test("CRLF typed into a text box and LF are the same email; a body never gains or loses a newline", () => {
  const raw = buildRawEmail({
    to: "a@example.com",
    subject: "Hello",
    body: "One\r\nTwo\n\nThree\n",
  });
  assert.equal(parseRawEmail(Buffer.from(raw)).text, "One\nTwo\n\nThree\n");
});

test("encoded subject words stay within 75 characters and never split a character's bytes", () => {
  const subject = "👩‍💻".repeat(30) + "é".repeat(40);
  const words = encodeHeaderWords(subject);
  assert.ok(words.length > 1);
  for (const word of words) {
    assert.ok(word.length <= 75, word);
    const data = /^=\?UTF-8\?B\?(.*)\?=$/.exec(word)![1];
    // Fatal decoding throws if a multi-byte sequence was cut between words.
    new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.from(data, "base64"),
    );
  }
  assert.equal(
    decodeHeaderWords(words.join("\r\n ").replace(/\r\n/g, "")),
    subject,
  );
});

test("plain ASCII subjects stay readable and literal encoded-word text is still encoded", () => {
  const plain = buildRawEmail({
    to: "a@example.com",
    subject: "Following up on my application",
    body: "Hi",
  });
  assert.match(plain, /\r\nSubject: Following up on my application\r\n/);
  const tricky = "Literal =?UTF-8?B?SGk=?= text";
  const raw = buildRawEmail({
    to: "a@example.com",
    subject: tricky,
    body: "Hi",
  });
  assert.equal(parseRawEmail(Buffer.from(raw)).subject, tricky);
});

test("header injection and malformed recipients are rejected before anything is built", () => {
  const base = { to: "a@example.com", subject: "Hello", body: "Body" };
  assert.throws(
    () => buildRawEmail({ ...base, subject: "Hi\r\nBcc: x@example.com" }),
    /one-line subject/,
  );
  for (const to of [
    "a@example.com\r\nBcc: b@example.com",
    "Name <a@example.com>",
    "a@example.com, b@example.com",
    "a@@example.com",
    "a@example",
    "",
  ])
    assert.throws(() => buildRawEmail({ ...base, to }), /valid recipient/, to);
  assert.throws(
    () => buildRawEmail({ ...base, body: "  \n " }),
    /Write the email/,
  );
});

test("the parser reads Gmail copies that were re-encoded as quoted-printable or wrapped in multipart", () => {
  const body = "Café “quotes” — 👋🏽\nSecond line = equals";
  const qp = Buffer.from(body.replace(/\n/g, "\r\n"), "utf8")
    .toString("latin1")
    .replace(
      /[^\x20-\x3c\x3e-\x7e\r\n]/g,
      (c) => `=${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
    )
    .replace(/=/g, (m, i, s) =>
      s.slice(i + 1, i + 3).match(/^[0-9A-F]{2}$/) ? m : "=3D",
    );
  const raw = [
    "To: a@example.com",
    "Subject: =?utf-8?Q?Caf=C3=A9_follow-up?=",
    'Content-Type: multipart/alternative; boundary="b1"',
    "",
    "--b1",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: quoted-printable",
    "",
    qp,
    "--b1",
    "Content-Type: text/html; charset=UTF-8",
    "",
    "<p>ignored</p>",
    "--b1--",
    "",
  ].join("\r\n");
  const parsed = parseRawEmail(Buffer.from(raw, "latin1"));
  assert.equal(parsed.subject, "Café follow-up");
  assert.equal(parsed.html, "<p>ignored</p>");
  assert.deepEqual(parsed.versions, { plain: 1, html: 1 });
  assert.equal(
    parsed.text,
    body,
    "the line break before a boundary is not part of the text",
  );
});

test("a leading U+FEFF is part of the text, not a byte-order mark to drop", () => {
  const raw = buildRawEmail({
    to: "a@example.com",
    subject: "Hello",
    body: "\uFEFFHello",
  });
  const parsed = parseRawEmail(Buffer.from(raw));
  assert.equal(parsed.text, "\uFEFFHello");
  assert.equal(parsed.html, '<div dir="ltr">\uFEFFHello</div>');
});

test("a copy whose bytes are not valid in its declared charset is reported, not silently repaired", () => {
  const raw = [
    "To: a@example.com",
    "Subject: Hello",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from([0x63, 0x61, 0x66, 0xe9]).toString("base64"),
    "",
  ].join("\r\n");
  assert.throws(() => parseRawEmail(Buffer.from(raw)), /could not be decoded/);
});
