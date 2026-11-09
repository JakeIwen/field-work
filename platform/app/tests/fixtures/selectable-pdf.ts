// Small actual PDF fixture with selectable text and contact annotations. It is
// shared by native validation tests and the isolated browser verification data.
export function selectablePdf(lines: string[], pages = 1) {
  const escape = (text: string) => text.replace(/[\\()]/g, "\\$&");
  const stream =
    "BT /F1 10 Tf 48 740 Td 14 TL\n" +
    lines
      .flatMap((line) =>
        (line.match(/.{1,75}(?:\s|$)/g) || [line]).map(
          (part) => `(${escape(part.trim())}) Tj T*`,
        ),
      )
      .join("\n") +
    "\nET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, index) => `${8 + index} 0 R`).join(" ")}] /Count ${pages} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Annot /Subtype /Link /Rect [48 700 140 715] /A << /S /URI /URI (https://github.com/sam-rivera-example) >> >>",
    "<< /Type /Annot /Subtype /Link /Rect [150 700 250 715] /A << /S /URI /URI (mailto:sam.rivera@example.com) >> >>",
    "<< >>",
    ...Array.from(
      { length: pages },
      () =>
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 4 0 R /Annots [5 0 R 6 0 R] >>",
    ),
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  return Buffer.from(
    pdf +
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
  );
}
