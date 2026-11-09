import Foundation
import PDFKit

// Trusted validator: receives only app-validated isolated artifact paths.
// The caller selects document type explicitly; filenames cannot relax checks.
var arguments = Array(CommandLine.arguments.dropFirst())
let coverLetter = arguments.first == "--cover-letter"
if coverLetter { arguments.removeFirst() }
func require(_ condition: Bool, _ message: String) {
    if !condition {
        FileHandle.standardError.write(Data(("Validation failed: " + message + "\n").utf8))
        exit(1)
    }
}
require(arguments.count >= 2, "Expected Markdown source and PDF paths")
let source = try String(contentsOfFile: arguments[0], encoding: .utf8)
require(!source.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, "Markdown source is empty")
let expectedPages = coverLetter ? 1 : 2
let label = coverLetter ? "Cover letter" : "Resume"
func normalized(_ text: String) -> String {
    text.precomposedStringWithCompatibilityMapping.replacingOccurrences(of: "[\\s*#|:\u{2022}]", with: "", options: .regularExpression).lowercased()
}
let phonePattern = "(?:\\+?1[- .]?)?\\(?\\d{3}\\)?[- .]?\\d{3}[- .]?\\d{4}"
let phoneRange = source.range(of: phonePattern, options: .regularExpression)
let phone = phoneRange.map { String(source[$0]) }
let contactLine = source.components(separatedBy: .newlines).first(where: { $0.contains("@") }) ?? ""
let contacts = contactLine.replacingOccurrences(of: "**", with: "").components(separatedBy: " | ")
let expectedUrls = Set(contacts.compactMap { contact -> String? in
    let value = contact.trimmingCharacters(in: .whitespacesAndNewlines)
    if value.contains("@") { return "mailto:" + value }
    if value.hasPrefix("github.com/") { return "https://" + value }
    if value.hasPrefix("https://") { return value }
    return nil
})
require(coverLetter || !expectedUrls.isEmpty, "Source contact links missing")
for file in arguments.dropFirst() {
    guard let document = PDFDocument(url: URL(fileURLWithPath: file)) else { require(false, "Unreadable PDF: \(file)"); exit(1) }
    require(document.pageCount == expectedPages, "\(label) PDF must contain \(expectedPages) page(s): \(URL(fileURLWithPath: file).lastPathComponent)")
    var count = 0
    for index in 0..<document.pageCount {
        let text = document.page(at: index)?.string ?? ""
        require(text.count > 300, "Page must contain selectable \(label.lowercased()) text")
        count += text.count
    }
    let text = document.string ?? ""
    let publicVariant = URL(fileURLWithPath: file).lastPathComponent.lowercased().hasSuffix("_public.pdf")
    if let phone = phone { require(text.contains(phone) != publicVariant, "Phone visibility must match variant") }
    if publicVariant || phone == nil {
        require(text.range(of: phonePattern, options: .regularExpression) == nil, "PDF must not introduce a phone absent from this variant's source")
    }
    let extracted = normalized(text)
    var checked = 0
    var inSkills = false
    for raw in source.components(separatedBy: .newlines) {
        let line = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if line.isEmpty || line.hasPrefix(">") { continue }
        if line == "## TECHNICAL SKILLS" { inSkills = true }
        if line == "## PROFESSIONAL EXPERIENCE" { inSkills = false }
        var pieces = line.components(separatedBy: " | ")
        if inSkills && line.hasPrefix("- **"), let range = line.range(of: ":** ") {
            pieces = [String(line[..<range.lowerBound]), String(line[range.upperBound...])]
        }
        for var piece in pieces {
            if piece.hasPrefix("- ") { piece = String(piece.dropFirst(2)) }
            if publicVariant && piece == phone { continue }
            require(extracted.contains(normalized(piece)), "PDF does not contain source block: \(piece)")
            checked += 1
        }
    }
    var urls = Set<String>()
    for index in 0..<document.pageCount {
        for annotation in document.page(at: index)!.annotations {
            if let url = (annotation.action as? PDFActionURL)?.url { urls.insert(url.absoluteString) }
        }
    }
    require(expectedUrls.isSubset(of: urls), "Contact links missing")
    print("PASS \(URL(fileURLWithPath: file).lastPathComponent): \(expectedPages) page(s); \(count) selectable characters; \(checked) source blocks; contact links and phone visibility correct")
}
