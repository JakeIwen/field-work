import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeBase64,
  digest,
  hasPdfMagic,
  maxAttachmentBytes,
  normalizeGreenhouseLabel,
  validGreenhouseAttachment,
  type HelperAttachmentInput,
} from "../scripts/helper-contract.js";
import { maxAttachmentBytes as serverLimit } from "../server/preparation-documents.js";

const pdf = new TextEncoder().encode("%PDF-1.7\nsynthetic");
const attachment: HelperAttachmentInput = {
  kind: "resume",
  name: "resume.pdf",
  mime: "application/pdf",
  hash: "a".repeat(64),
  size: pdf.length,
  base64: Buffer.from(pdf).toString("base64"),
};
const validators = [validGreenhouseAttachment];
const validity = (changes: Partial<HelperAttachmentInput>) =>
  validators.map((validate) => validate({ ...attachment, ...changes }));

test("helper PDF limit agrees with server attachment packaging", () => {
  assert.equal(maxAttachmentBytes, serverLimit);
  assert.deepEqual(validity({ size: maxAttachmentBytes }), [true]);
  assert.deepEqual(validity({ size: maxAttachmentBytes + 1 }), [false]);
});

test("attachment metadata retains Greenhouse filename checks", () => {
  assert.deepEqual(validity({}), [true]);
  assert.deepEqual(validity({ name: "RESUME.PDF" }), [true]);
  assert.deepEqual(validity({ name: ".pdf" }), [true]);
  for (const name of [
    "path/resume.pdf",
    "path\\resume.pdf",
    "a\u0000.pdf",
    "a\n.pdf",
  ]) {
    assert.deepEqual(validity({ name }), [true], name);
  }
  for (const name of ["", "resume.txt", "resume.pdf "]) {
    assert.deepEqual(validity({ name }), [false], name);
  }
});

test("attachment MIME, digest spelling and kinds retain existing validation", () => {
  for (const mime of ["", "APPLICATION/PDF", "text/plain"]) {
    assert.deepEqual(validity({ mime }), [false]);
  }
  for (const hash of ["", "A".repeat(64), "a".repeat(63), "g".repeat(64)]) {
    assert.deepEqual(validity({ hash }), [false]);
  }
  assert.deepEqual(validity({ kind: "cover-letter" }), [true]);
  // Greenhouse validates the DOM slot id outside this pure metadata predicate.
  assert.deepEqual(validity({ kind: "other" }), [true]);
});

test("Greenhouse retains permissive declared-size and base64 preflight", () => {
  for (const size of [0, -1, 4, 5.5, NaN]) {
    assert.deepEqual(validity({ size }), [true]);
  }
  assert.deepEqual(validity({ size: 5 }), [true]);
  assert.deepEqual(validity({ size: Infinity }), [false]);
  assert.deepEqual(validity({ base64: "" }), [true]);
  assert.deepEqual(validity({ base64: undefined }), [true]);
});

test("base64 decoding keeps native empty, whitespace and malformed-input behavior", () => {
  assert.deepEqual(decodeBase64(attachment.base64), pdf);
  assert.deepEqual(decodeBase64(" \n" + attachment.base64 + "\t"), pdf);
  assert.deepEqual(decodeBase64(""), new Uint8Array());
  for (const value of ["!", "a", "===="]) {
    assert.throws(() => decodeBase64(value), { name: "InvalidCharacterError" });
  }
});

test("PDF magic accepts only the exact leading five PDF bytes", () => {
  assert.equal(hasPdfMagic(pdf), true);
  assert.equal(hasPdfMagic(new TextEncoder().encode("%PDF-")), true);
  for (const value of ["", "%PDF", "%pdf-", " %PDF-", "not-pdf", "﻿%PDF-"]) {
    assert.equal(hasPdfMagic(new TextEncoder().encode(value)), false, value);
  }
});

test("shared PDF magic agrees with both legacy checks for every one-byte substitution", () => {
  const magic = new TextEncoder().encode("%PDF-");
  const agrees = (bytes: Uint8Array) => {
    const decoded = new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-";
    const characters = String.fromCharCode(...bytes.slice(0, 5)) === "%PDF-";
    assert.equal(hasPdfMagic(bytes), decoded);
    assert.equal(hasPdfMagic(bytes), characters);
  };
  for (let position = 0; position < magic.length; position++) {
    for (let value = 0; value <= 255; value++) {
      const bytes = magic.slice();
      bytes[position] = value;
      agrees(bytes);
    }
  }
  for (let length = 0; length < magic.length; length++)
    agrees(magic.slice(0, length));
  agrees(pdf);
});

test("digest emits unchanged lowercase padded SHA-256 hex for empty and PDF bytes", async () => {
  assert.equal(
    await digest(new Uint8Array()),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  assert.equal(
    await digest(new TextEncoder().encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  const hash = await digest(pdf);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(await digest(decodeBase64(attachment.base64)), hash);
});

test("semantic normalization preserves case and Greenhouse asterisk policy", () => {
  assert.equal(normalizeGreenhouseLabel("  Full *\n Name\t "), "Full Name");
});
