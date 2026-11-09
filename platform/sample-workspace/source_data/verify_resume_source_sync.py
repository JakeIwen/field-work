#!/usr/bin/env python3
"""Verify that the current Markdown resume matches private/public HTML variants."""

from __future__ import annotations

import html
import re
import sys
from html.parser import HTMLParser
from pathlib import Path



class VisibleTextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._ignored_depth = 0
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"style", "script", "title"}:
            self._ignored_depth += 1

    def handle_endtag(self, tag: str) -> None:
        if tag in {"style", "script", "title"} and self._ignored_depth:
            self._ignored_depth -= 1

    def handle_data(self, data: str) -> None:
        if not self._ignored_depth:
            self.parts.append(data)


def normalize(value: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(value)).strip()


def comparison_normalize(value: str) -> str:
    normalized = normalize(value.replace(":", "").replace("•", " ").replace("|", " ")).lower()
    return re.sub(r"\s+([,;])", r"\1", normalized)


def visible_html(path: Path) -> str:
    parser = VisibleTextParser()
    parser.feed(path.read_text(encoding="utf-8"))
    return comparison_normalize(" ".join(parser.parts))


def markdown_pieces(path: Path) -> list[str]:
    pieces: list[str] = []
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith(">"):
            continue
        line = re.sub(r"^#{1,6}\s+", "", line)
        line = re.sub(r"^-\s+", "", line)
        line = line.replace("**", "").replace("`", "")
        if line.startswith("*") and line.endswith("*"):
            line = line[1:-1]
        for part in line.split(" | "):
            part = comparison_normalize(part)
            if part:
                pieces.append(part)
    return pieces


def main() -> int:
    if len(sys.argv) not in (3, 4):
        print(
            "usage: verify_resume_source_sync.py MASTER.md PRIVATE.html [PUBLIC.html]",
            file=sys.stderr,
        )
        return 2

    markdown_path, private_path = map(Path, sys.argv[1:3])
    public_path = Path(sys.argv[3]) if len(sys.argv) == 4 else None
    phone_match = re.search(r"(?:\+?1[- .]?)?\(?\d{3}\)?[- .]\d{3}[- .]\d{4}", markdown_path.read_text(encoding="utf-8"))
    phone = phone_match.group() if phone_match else None
    expected = markdown_pieces(markdown_path)
    private_text = visible_html(private_path)
    public_text = visible_html(public_path) if public_path else None

    private_missing = [piece for piece in expected if piece not in private_text]
    public_expected = [piece for piece in expected if piece != phone]
    public_missing = [piece for piece in public_expected if public_text is not None and piece not in public_text]

    errors: list[str] = []
    if private_missing:
        errors.append("private HTML is missing:\n- " + "\n- ".join(private_missing))
    if public_missing:
        errors.append("public HTML is missing:\n- " + "\n- ".join(public_missing))
    if phone and phone not in private_text:
        errors.append("private HTML does not contain the phone number")
    if public_text is not None and phone and phone in public_text:
        errors.append("public HTML contains the phone number")

    expected_private_text = comparison_normalize(" ".join(expected))
    expected_public_text = comparison_normalize(" ".join(public_expected))
    if private_text != expected_private_text:
        errors.append("private HTML has extra, reordered, or changed visible content")
    if public_text is not None and public_text != expected_public_text:
        errors.append("public HTML has extra, reordered, or changed visible content")

    if errors:
        print("resume source synchronization FAILED", file=sys.stderr)
        print("\n\n".join(errors), file=sys.stderr)
        return 1

    print(
        f"resume source synchronization passed: {len(expected)} content blocks; "
        + ("public phone omitted" if public_path else "private variant checked")
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
