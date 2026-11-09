// Only value checks belong here. The executors own validation timing, DOM guards,
// existing-answer preservation, uploads, and provider-specific interactions.
export const maxAttachmentBytes = 8 * 1024 * 1024;

export interface HelperAttachmentInput {
  kind: string;
  mime: string;
  name: string;
  hash: string;
  size: number;
  base64: string;
}

export function normalizeGreenhouseLabel(s: string) {
  return s.replace(/\*/g, "").replace(/\s+/g, " ").trim();
}

export async function digest(bytes: BufferSource) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function decodeBase64(value: string) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

export const hasPdfMagic = (bytes: Uint8Array) =>
  bytes[0] === 0x25 &&
  bytes[1] === 0x50 &&
  bytes[2] === 0x44 &&
  bytes[3] === 0x46 &&
  bytes[4] === 0x2d;

export const isSha256Hex = (value: string) => /^[a-f0-9]{64}$/.test(value);
export const isPdfMime = (value: string) => value === "application/pdf";
export const isPdfName = (value: string) => /\.pdf$/i.test(value);
// This intentionally accepts NaN, negative and fractional sizes. Greenhouse's
// legacy preflight leaves stricter file verification to the executor.
export const withinAttachmentBytes = (size: number) =>
  !(size > maxAttachmentBytes);
export function validGreenhouseAttachment(file: HelperAttachmentInput) {
  return (
    isPdfMime(file.mime) &&
    isPdfName(file.name) &&
    isSha256Hex(file.hash) &&
    withinAttachmentBytes(file.size)
  );
}
