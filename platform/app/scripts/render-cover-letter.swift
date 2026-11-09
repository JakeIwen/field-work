import Foundation
import AppKit
import CoreText
import CoreGraphics
import PDFKit

// Trusted renderer; user/agent text is data, never executable markup.
precondition(CommandLine.arguments.count == 4, "Expected letter text, resume Markdown, output PDF")
// Blank lines are paragraph breaks. Collapse them so a gap costs paragraph spacing only,
// not an empty line plus two spacings, which capped four-paragraph letters near 310 words.
// Runs of whitespace-only lines collapse too; a single pass over "\n[ \t]*\n+" left one behind.
let letter = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
    .replacingOccurrences(of: "\r\n?", with: "\n", options: .regularExpression)
    .replacingOccurrences(of: "[ \t]+\n", with: "\n", options: .regularExpression)
    .replacingOccurrences(of: "\n\n+", with: "\n", options: .regularExpression)
    .trimmingCharacters(in: .whitespacesAndNewlines)
let resume = try String(contentsOfFile: CommandLine.arguments[2], encoding: .utf8)
let name = resume.components(separatedBy: .newlines).first(where: { $0.hasPrefix("# ") }).map { String($0.dropFirst(2)) } ?? "Applicant"
let contacts = (resume.components(separatedBy: .newlines).first(where: { $0.contains("@") }) ?? "").replacingOccurrences(of: "**", with: "")
precondition(!letter.isEmpty && letter.count < 12000, "Cover letter text is missing or too long")
let output = URL(fileURLWithPath: CommandLine.arguments[3])
guard let consumer = CGDataConsumer(url: output as CFURL) else { fatalError("Unable to create PDF") }
var box = CGRect(x: 0, y: 0, width: 612, height: 792)
guard let context = CGContext(consumer: consumer, mediaBox: &box, nil) else { fatalError("Unable to create PDF context") }
context.beginPDFPage(nil)
@discardableResult
func draw(_ text: String, size: CGFloat, y: CGFloat, height: CGFloat, leading: CGFloat) -> (frame: CTFrame, origin: CGPoint) {
    let font = CTFontCreateWithName("Helvetica" as CFString, size, nil)
    let paragraph = NSMutableParagraphStyle()
    paragraph.minimumLineHeight = leading
    paragraph.maximumLineHeight = leading
    paragraph.paragraphSpacing = 8
    let attributes: [NSAttributedString.Key: Any] = [.font: font, .paragraphStyle: paragraph]
    let attributed = NSAttributedString(string: text, attributes: attributes)
    let framesetter = CTFramesetterCreateWithAttributedString(attributed)
    let origin = CGPoint(x: 45, y: y)
    let frame = CTFramesetterCreateFrame(framesetter, CFRange(location: 0, length: 0), CGPath(rect: CGRect(origin: origin, size: CGSize(width: 522, height: height)), transform: nil), nil)
    if CTFrameGetVisibleStringRange(frame).length != attributed.length {
        let needed = CTFramesetterSuggestFrameSizeWithConstraints(framesetter, CFRange(location: 0, length: 0), nil, CGSize(width: 522, height: CGFloat.greatestFiniteMagnitude), nil).height
        // Not phrased as "Page N overflowed by": measured renderer overflow starts automatic
        // shortening, and a letter should first be checked for layout inflation.
        preconditionFailure("Letter text overflows one page by about \(String(format: "%.1f", max(needed - height, 0.1))) points at the standard layout. First check cover_letter.txt for layout inflation, such as hard line breaks inside a paragraph; if it still overflows, shorten it by evidence priority, keeping the paragraph breaks, and retry")
    }
    CTFrameDraw(frame, context)
    return (frame, origin)
}
// Page rectangles covering a character range of a drawn frame, one per line it spans.
func rects(of range: NSRange, in frame: CTFrame, at origin: CGPoint) -> [CGRect] {
    let lines = CTFrameGetLines(frame) as! [CTLine]
    var origins = [CGPoint](repeating: .zero, count: lines.count)
    CTFrameGetLineOrigins(frame, CFRange(location: 0, length: 0), &origins)
    return zip(lines, origins).compactMap { line, lineOrigin in
        let lineRange = CTLineGetStringRange(line)
        let start = max(range.location, lineRange.location)
        let end = min(range.location + range.length, lineRange.location + lineRange.length)
        guard start < end else { return nil }
        var ascent: CGFloat = 0, descent: CGFloat = 0
        CTLineGetTypographicBounds(line, &ascent, &descent, nil)
        let left = CTLineGetOffsetForStringIndex(line, start, nil)
        let right = CTLineGetOffsetForStringIndex(line, end, nil)
        return CGRect(x: origin.x + lineOrigin.x + left, y: origin.y + lineOrigin.y - descent, width: right - left, height: ascent + descent)
    }
}
draw(name, size: 20, y: 706, height: 40, leading: 25)
let contactLine = draw(contacts, size: 9.5, y: 675, height: 35, leading: 13)
// Contact links use the same visible text captured from the resume header. They are
// set on the drawing context, as the resume renderer does, which writes an invisible
// border (/Border [0 0 0]); a PDFKit link annotation added after rendering came out
// with an empty border-style dictionary on macOS 27, whose default width draws a box.
var links: [(text: String, url: URL, rects: [CGRect])] = []
let header = contacts as NSString
var cursor = 0
for contact in contacts.components(separatedBy: " | ") {
    let value = contact.trimmingCharacters(in: .whitespaces)
    // Search from this component's own start, so a repeated or substring value
    // (sub.example.dev | example.dev) links its own text, not the first match.
    let range = header.range(of: value, options: [], range: NSRange(location: cursor, length: header.length - cursor))
    cursor += (contact as NSString).length + 3
    let address = value.contains("@") ? "mailto:" + value : (value.hasPrefix("https://") ? value : "https://" + value)
    guard let url = URL(string: address),
          url.scheme == "mailto" || (url.scheme == "https" && url.host?.contains(".") == true),
          range.location != NSNotFound else { continue }
    let placed = rects(of: range, in: contactLine.frame, at: contactLine.origin)
    for rect in placed { context.setURL(url as CFURL, for: rect) }
    links.append((value, url, placed))
}
draw(letter, size: 11.5, y: 42, height: 610, leading: 15.5)
context.endPDFPage(); context.closePDF()
guard let pdf = PDFDocument(url: output), let page = pdf.page(at: 0) else { fatalError("Cannot reopen generated PDF") }
precondition(pdf.pageCount == 1, "Cover letter must be one page")
let extracted = pdf.string ?? ""
func normalize(_ text: String) -> String { text.precomposedStringWithCompatibilityMapping.replacingOccurrences(of: "\\s+", with: "", options: .regularExpression) }
precondition(normalize(extracted).contains(normalize(contacts)), "Generated PDF is missing contact details")
for paragraph in letter.components(separatedBy: "\n").filter({ !$0.trimmingCharacters(in: .whitespaces).isEmpty }) {
    precondition(normalize(extracted).contains(normalize(paragraph)), "Generated PDF is missing letter text")
}
// Each contact link must sit on its text and draw no border: a border-style dictionary
// (/BS) takes precedence over /Border, and both default to a one-point visible border.
func visibleBorderWidth(_ annotation: PDFAnnotation) -> Double {
    if let style = annotation.value(forAnnotationKey: .borderStyle) as? [AnyHashable: Any] {
        return ((style["W"] ?? style["/W"]) as? NSNumber)?.doubleValue ?? 1
    }
    if let border = annotation.value(forAnnotationKey: .border) as? [NSNumber], border.count >= 3 { return border[2].doubleValue }
    return annotation.border.map { Double($0.lineWidth) } ?? 1
}
// Every rectangle the renderer placed must come back as its own link annotation, at
// the same place (within half a point), with its URL, and no other link may exist.
func matches(_ annotation: PDFAnnotation, _ rect: CGRect) -> Bool {
    let bounds = annotation.bounds
    return [bounds.minX - rect.minX, bounds.minY - rect.minY, bounds.maxX - rect.maxX, bounds.maxY - rect.maxY].allSatisfy { abs($0) < 0.5 }
}
let placedRects = links.reduce(0) { $0 + $1.rects.count }
precondition(page.annotations.count == placedRects, "Generated PDF has \(page.annotations.count) annotations, expected \(placedRects) contact links")
for link in links {
    for rect in link.rects {
        guard let annotation = page.annotations.first(where: { ($0.action as? PDFActionURL)?.url == link.url && matches($0, rect) }) else {
            preconditionFailure("Generated PDF is missing the \(link.text) link at \(rect)")
        }
        precondition(visibleBorderWidth(annotation) == 0, "The \(link.text) link would draw a border")
    }
}
print("PASS cover letter: 1 page; \(extracted.count) selectable characters; complete body text; \(links.count) borderless contact links in \(placedRects) rectangles")
