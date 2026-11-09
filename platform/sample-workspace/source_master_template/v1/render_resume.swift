import AppKit
import CoreText
import Foundation

final class Node {
    let name: String
    let attributes: [String: String]
    weak var parent: Node?
    var children: [Node] = []
    var ownText = ""

    init(name: String, attributes: [String: String]) {
        self.name = name
        self.attributes = attributes
    }

    var classes: Set<String> {
        Set((attributes["class"] ?? "").split(separator: " ").map(String.init))
    }

    var text: String {
        (ownText + children.map(\.text).joined())
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

final class TreeBuilder: NSObject, XMLParserDelegate {
    let root = Node(name: "document", attributes: [:])
    private var current: Node

    override init() {
        current = root
        super.init()
    }

    func parser(_ parser: XMLParser, didStartElement elementName: String, namespaceURI: String?, qualifiedName qName: String?, attributes attributeDict: [String: String] = [:]) {
        let child = Node(name: elementName.lowercased(), attributes: attributeDict)
        child.parent = current
        current.children.append(child)
        current = child
    }

    func parser(_ parser: XMLParser, foundCharacters string: String) {
        let child = Node(name: "#text", attributes: [:])
        child.ownText = string
        child.parent = current
        current.children.append(child)
    }

    func parser(_ parser: XMLParser, didEndElement elementName: String, namespaceURI: String?, qualifiedName qName: String?) {
        if let parent = current.parent { current = parent }
    }
}

struct TextStyle {
    let font: CTFont
    let color: CGColor
    let lineHeight: CGFloat
    let kern: CGFloat
}

final class ResumeRenderer {
    private let pageWidth: CGFloat = 612
    private let pageHeight: CGFloat = 792
    private let left: CGFloat = 41.75
    private let right: CGFloat = 41.75
    private let top: CGFloat = 36
    private let bottom: CGFloat = 36
    private var y: CGFloat = 0
    private var pageNumber = 0
    private let context: CGContext
    // Wrapped-line facts for the overflow report. A cut shortens a page only when it
    // removes a block's last line, which the bare overflow measurement cannot tell an editor.
    private struct BlockLayout { let page: Int; let text: String; let lines: Int; let lastLineChars: Int }
    private var blockLayouts: [BlockLayout] = []
    private var drawnLines = 0
    private var drawnLastLine = ""

    private let body = TextStyle(font: CTFontCreateWithName("Helvetica Neue" as CFString, 10.5, nil), color: NSColor(calibratedWhite: 0.10, alpha: 1).cgColor, lineHeight: 13.23, kern: 0)
    private let bodyBold = TextStyle(font: CTFontCreateWithName("Helvetica Neue Bold" as CFString, 10.5, nil), color: NSColor(calibratedWhite: 0.10, alpha: 1).cgColor, lineHeight: 13.23, kern: 0)
    private let bodyItalic = TextStyle(font: CTFontCreateWithName("Helvetica Neue Italic" as CFString, 9.5, nil), color: NSColor(calibratedWhite: 0.27, alpha: 1).cgColor, lineHeight: 11.97, kern: 0)
    private let skill = TextStyle(font: CTFontCreateWithName("Helvetica Neue" as CFString, 10, nil), color: NSColor(calibratedWhite: 0.10, alpha: 1).cgColor, lineHeight: 12.6, kern: 0)
    private let skillBold = TextStyle(font: CTFontCreateWithName("Helvetica Neue Bold" as CFString, 10, nil), color: NSColor(calibratedWhite: 0.10, alpha: 1).cgColor, lineHeight: 12.6, kern: 0)

    init(output: URL) {
        guard let consumer = CGDataConsumer(url: output as CFURL) else { fatalError("Unable to create PDF consumer") }
        var mediaBox = CGRect(x: 0, y: 0, width: pageWidth, height: pageHeight)
        guard let pdf = CGContext(consumer: consumer, mediaBox: &mediaBox, nil) else { fatalError("Unable to create PDF context") }
        context = pdf
    }

    private var contentWidth: CGFloat { pageWidth - left - right }

    private func checkPageFits() {
        guard y > pageHeight - bottom else { return }
        let blocks = blockLayouts.filter { $0.page == pageNumber }.map { block -> [String: Any] in
            ["text": String(block.text.prefix(90)), "lines": block.lines, "lastLineChars": block.lastLineChars]
        }
        let report: [String: Any] = ["page": pageNumber, "lineHeight": body.lineHeight, "blocks": blocks]
        if let data = try? JSONSerialization.data(withJSONObject: report), let json = String(data: data, encoding: .utf8) {
            FileHandle.standardError.write(Data("Layout report: \(json)\n".utf8))
        }
        fatalError("Page \(pageNumber) overflowed by \(y - (pageHeight - bottom)) points")
    }

    private func recordBlock(_ text: String) {
        let readable = text.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
        blockLayouts.append(BlockLayout(page: pageNumber, text: readable, lines: drawnLines, lastLineChars: drawnLastLine.trimmingCharacters(in: .whitespacesAndNewlines).count))
    }

    private func startPage() {
        if pageNumber > 0 {
            checkPageFits()
            context.endPDFPage()
        }
        context.beginPDFPage([kCGPDFContextMediaBox as String: CGRect(x: 0, y: 0, width: pageWidth, height: pageHeight)] as CFDictionary)
        context.textMatrix = .identity
        y = top
        pageNumber += 1
    }

    func finish() {
        checkPageFits()
        context.endPDFPage()
        context.closePDF()
    }

    private func attributed(_ text: String, style: TextStyle) -> NSMutableAttributedString {
        NSMutableAttributedString(string: text, attributes: [
            NSAttributedString.Key(kCTFontAttributeName as String): style.font,
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): style.color,
            NSAttributedString.Key(kCTLigatureAttributeName as String): 0,
            NSAttributedString.Key(kCTKernAttributeName as String): style.kern
        ])
    }

    private func inline(_ node: Node, inherited: TextStyle? = nil) -> NSMutableAttributedString {
        let result = NSMutableAttributedString()
        let nodeStyle = (node.name == "b" || node.name == "strong") ? bodyBold : (inherited ?? body)
        if !node.ownText.isEmpty { result.append(attributed(node.ownText, style: nodeStyle)) }
        for child in node.children { result.append(inline(child, inherited: nodeStyle)) }
        return result
    }

    private func countLines(_ value: NSAttributedString, width: CGFloat) -> Int {
        let typesetter = CTTypesetterCreateWithAttributedString(value)
        var position = 0
        var count = 0
        while position < value.length {
            var length = CTTypesetterSuggestLineBreak(typesetter, position, Double(width))
            if length == 0 { length = 1 }
            position += length
            count += 1
        }
        return max(count, 1)
    }

    @discardableResult
    private func draw(_ value: NSAttributedString, x: CGFloat, width: CGFloat, style: TextStyle, topY: CGFloat? = nil, justify: Bool = false) -> CGFloat {
        let originY = topY ?? y
        let typesetter = CTTypesetterCreateWithAttributedString(value)
        var position = 0
        var lineIndex = 0
        drawnLastLine = ""
        while position < value.length {
            var length = CTTypesetterSuggestLineBreak(typesetter, position, Double(width))
            if length == 0 { length = 1 }
            let line = CTTypesetterCreateLine(typesetter, CFRange(location: position, length: length))
            let remaining = value.length - (position + length)
            let drawnLine = (justify && remaining > 0) ? (CTLineCreateJustifiedLine(line, 1.0, Double(width)) ?? line) : line
            let baseline = pageHeight - originY - CTFontGetAscent(style.font) - CGFloat(lineIndex) * style.lineHeight
            context.textPosition = CGPoint(x: x, y: baseline)
            CTLineDraw(drawnLine, context)
            drawnLastLine = (value.string as NSString).substring(with: NSRange(location: position, length: length))
            position += length
            lineIndex += 1
        }
        drawnLines = max(lineIndex, 1)
        return CGFloat(max(lineIndex, 1)) * style.lineHeight
    }

    private func drawPlain(_ text: String, style: TextStyle, x: CGFloat? = nil, width: CGFloat? = nil, topY: CGFloat? = nil, justify: Bool = false) -> CGFloat {
        draw(attributed(text, style: style), x: x ?? left, width: width ?? contentWidth, style: style, topY: topY, justify: justify)
    }

    private func descendant(_ root: Node, className: String) -> Node? {
        if root.classes.contains(className) { return root }
        for child in root.children {
            if let match = descendant(child, className: className) { return match }
        }
        return nil
    }

    private func drawHeader(_ node: Node) {
        let name = descendant(node, className: "name")?.text ?? ""
        let headline = descendant(node, className: "headline")?.text ?? ""
        var contact = descendant(node, className: "contact")?.text ?? ""
        contact = contact.replacingOccurrences(of: "•", with: " • ")
        let nameStyle = TextStyle(font: CTFontCreateWithName("Helvetica Neue Bold" as CFString, 23, nil), color: body.color, lineHeight: 25.5, kern: 2.5)
        let headlineStyle = TextStyle(font: CTFontCreateWithName("Helvetica Neue Bold" as CFString, 11.5, nil), color: NSColor(calibratedWhite: 0.16, alpha: 1).cgColor, lineHeight: 14.5, kern: 0.4)
        let contactStyle = TextStyle(font: CTFontCreateWithName("Helvetica Neue" as CFString, 9.5, nil), color: NSColor(calibratedWhite: 0.27, alpha: 1).cgColor, lineHeight: 12, kern: 0)
        y += drawPlain(name, style: nameStyle)
        y += 2
        let websiteText = "sam.example.com"
        let githubText = "github.com/sam-rivera-example"
        let emailText = "sam.rivera@example.com"
        func measuredWidth(_ text: String) -> CGFloat {
            CGFloat(CTLineGetTypographicBounds(CTLineCreateWithAttributedString(attributed(text, style: contactStyle)), nil, nil, nil))
        }
        // An optional location shares the role row; contact details then take their own
        // right-aligned row so neither string wraps.
        var location = descendant(node, className: "location")?.text ?? ""
        location = location.replacingOccurrences(of: "•", with: " • ")
        let contactWidth = measuredWidth(contact)
        let contactX = left + contentWidth - contactWidth
        let rowTop = y
        let baselineOffset = max(CTFontGetAscent(headlineStyle.font) - CTFontGetAscent(contactStyle.font), 0)
        let contactTop: CGFloat
        if location.isEmpty {
            contactTop = rowTop + baselineOffset
            _ = drawPlain(headline, style: headlineStyle, width: contentWidth - contactWidth - 12, topY: rowTop)
            _ = drawPlain(contact, style: contactStyle, x: contactX, width: contactWidth + 1, topY: contactTop)
            y += max(headlineStyle.lineHeight, baselineOffset + contactStyle.lineHeight)
        } else {
            let locationWidth = measuredWidth(location)
            _ = drawPlain(headline, style: headlineStyle, width: contentWidth - locationWidth - 12, topY: rowTop)
            _ = drawPlain(location, style: contactStyle, x: left + contentWidth - locationWidth, width: locationWidth + 1, topY: rowTop + baselineOffset)
            y += max(headlineStyle.lineHeight, baselineOffset + contactStyle.lineHeight)
            y += 1
            contactTop = y
            _ = drawPlain(contact, style: contactStyle, x: contactX, width: contactWidth + 1, topY: contactTop)
            y += contactStyle.lineHeight
        }
        let linkY = pageHeight - contactTop - contactStyle.lineHeight
        if let range = contact.range(of: websiteText) {
            let prefix = String(contact[..<range.lowerBound])
            context.setURL(URL(string: "https://sam.example.com")! as CFURL, for: CGRect(x: contactX + measuredWidth(prefix), y: linkY, width: measuredWidth(websiteText), height: contactStyle.lineHeight))
        }
        if let range = contact.range(of: githubText) {
            let prefix = String(contact[..<range.lowerBound])
            context.setURL(URL(string: "https://github.com/sam-rivera-example")! as CFURL, for: CGRect(x: contactX + measuredWidth(prefix), y: linkY, width: measuredWidth(githubText), height: contactStyle.lineHeight))
        }
        if let range = contact.range(of: emailText) {
            let prefix = String(contact[..<range.lowerBound])
            context.setURL(URL(string: "mailto:sam.rivera@example.com")! as CFURL, for: CGRect(x: contactX + measuredWidth(prefix), y: linkY, width: measuredWidth(emailText), height: contactStyle.lineHeight))
        }
        y += 6
        context.setStrokeColor(NSColor(calibratedWhite: 0.16, alpha: 1).cgColor)
        context.setLineWidth(1.4)
        context.move(to: CGPoint(x: left, y: pageHeight - y))
        context.addLine(to: CGPoint(x: pageWidth - right, y: pageHeight - y))
        context.strokePath()
    }

    private func drawHeading(_ node: Node) {
        y += 8.5
        let heading = TextStyle(font: CTFontCreateWithName("Helvetica Neue Bold" as CFString, 9.5, nil), color: NSColor(calibratedWhite: 0.16, alpha: 1).cgColor, lineHeight: 11.97, kern: 1.2)
        y += drawPlain(node.text.uppercased(), style: heading)
        y += 2
        context.setStrokeColor(NSColor(calibratedWhite: 0.71, alpha: 1).cgColor)
        context.setLineWidth(0.7)
        context.move(to: CGPoint(x: left, y: pageHeight - y))
        context.addLine(to: CGPoint(x: pageWidth - right, y: pageHeight - y))
        context.strokePath()
        y += 2.5
    }

    private func drawSkillRow(_ node: Node) {
        let elements = node.children.filter { $0.name != "#text" }
        guard elements.count >= 2 else { return }
        let labelWidth: CGFloat = 112
        let gap: CGFloat = 3
        y += 0.5
        let labelText = elements[0].text
        let valueText = elements[1].text
        let labelValue = attributed(labelText, style: skillBold)
        let valueValue = attributed(valueText, style: skill)
        let valueX = left + labelWidth + gap
        let valueWidth = contentWidth - labelWidth - gap
        let labelHeight = draw(labelValue, x: left, width: labelWidth, style: skillBold, topY: y)
        let valueHeight = draw(valueValue, x: valueX, width: valueWidth, style: skill, topY: y)
        y += max(labelHeight, valueHeight) + 0.5
    }

    private func drawJobLine(_ node: Node) {
        let title = descendant(node, className: "co")?.text ?? ""
        let dates = descendant(node, className: "dates")?.text ?? ""
        let titleStyle = TextStyle(font: CTFontCreateWithName("Helvetica Neue Bold" as CFString, 11, nil), color: body.color, lineHeight: 13.86, kern: 0)
        let dateStyle = bodyItalic
        let dateValue = attributed(dates, style: dateStyle)
        let dateLine = CTLineCreateWithAttributedString(dateValue)
        let dateWidth = CGFloat(CTLineGetTypographicBounds(dateLine, nil, nil, nil))
        let titleWidth = contentWidth - dateWidth - 12
        let height = max(
            CGFloat(countLines(attributed(title, style: titleStyle), width: titleWidth)) * titleStyle.lineHeight,
            dateStyle.lineHeight
        )
        _ = drawPlain(title, style: titleStyle, width: titleWidth, topY: y)
        _ = drawPlain(dates, style: dateStyle, x: left + contentWidth - dateWidth, width: dateWidth + 1, topY: y)
        y += height
    }

    private func drawList(_ node: Node) {
        for item in node.children where item.name == "li" {
            let value = inline(item)
            _ = drawPlain("•", style: body, x: left + 1, width: 9, topY: y)
            let height = draw(value, x: left + 15, width: contentWidth - 15, style: body, topY: y)
            recordBlock(value.string)
            y += height + 2.1
        }
    }

    private func render(_ node: Node) {
        if node.name == "head" || node.name == "style" || node.name == "script" || node.name == "#text" { return }
        if node.name == "header" { drawHeader(node); return }
        if node.name == "h2" { drawHeading(node); return }
        if node.classes.contains("page-break") { startPage(); return }
        if node.classes.contains("skills") {
            y += 3
            let rows = node.children.filter { $0.classes.contains("skill-row") }
            for (index, row) in rows.enumerated() {
                if index > 0 { y += 4 }
                drawSkillRow(row)
            }
            return
        }
        if node.classes.contains("skill-row") { drawSkillRow(node); return }
        if node.classes.contains("job") {
            y += 4.5
            for child in node.children { render(child) }
            return
        }
        if node.classes.contains("jobline") { drawJobLine(node); return }
        if node.classes.contains("roleline") { y += 0.5; y += drawPlain(node.text, style: bodyItalic); return }
        if node.classes.contains("coblurb") { y += 3; y += drawPlain(node.text, style: body); recordBlock(node.text); return }
        if node.classes.contains("lane") {
            y += 4.5
            let laneStyle = TextStyle(font: CTFontCreateWithName("Helvetica Neue Bold" as CFString, 10, nil), color: NSColor(calibratedWhite: 0.16, alpha: 1).cgColor, lineHeight: 12.6, kern: 0.2)
            y += drawPlain(node.text, style: laneStyle)
            y += 1
            return
        }
        if node.name == "p" {
            y += 2
            y += drawPlain(node.text, style: body)
            recordBlock(node.text)
            return
        }
        if node.name == "ul" { y += 1.5; drawList(node); return }
        for child in node.children { render(child) }
    }

    func render(document: Node) {
        startPage()
        render(document)
        if pageNumber != 2 { fatalError("Expected 2 pages; generated \(pageNumber)") }
    }
}

guard CommandLine.arguments.count == 3 else {
    fputs("usage: swift render_resume.swift INPUT.html OUTPUT.pdf\n", stderr)
    exit(2)
}

let input = URL(fileURLWithPath: CommandLine.arguments[1])
let output = URL(fileURLWithPath: CommandLine.arguments[2])
let parser = XMLParser(data: try Data(contentsOf: input))
let builder = TreeBuilder()
parser.delegate = builder
guard parser.parse() else { fatalError("HTML/XML parse failed: \(parser.parserError?.localizedDescription ?? "unknown error")") }
let renderer = ResumeRenderer(output: output)
renderer.render(document: builder.root)
renderer.finish()
