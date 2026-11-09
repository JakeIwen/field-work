export const norm = (text: unknown) =>
  String(text ?? "")
    .replace(/\r/g, "")
    .replace(/\s+/g, " ")
    .trim();
