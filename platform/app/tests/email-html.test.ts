import test from "node:test";
import assert from "node:assert/strict";
import { plainTextHtml } from "../server/email-html.js";

test("each line break is a <br>, so blank lines stay paragraph breaks and CRLF matches LF", () => {
  const text = "Hello,\n\nFirst paragraph.\nSecond line.\n\nBest,\nSam";
  const html = plainTextHtml(text);
  assert.equal(
    html,
    '<div dir="ltr">Hello,<br>\r\n<br>\r\nFirst paragraph.<br>\r\nSecond line.<br>\r\n<br>\r\nBest,<br>\r\nSam</div>',
  );
  assert.equal(plainTextHtml(text.replace(/\n/g, "\r\n")), html);
});

test("markup in the text is shown as text, never interpreted", () => {
  assert.equal(
    plainTextHtml('Use <b>bold</b> & "quotes" <script>x</script>'),
    '<div dir="ltr">Use &lt;b&gt;bold&lt;/b&gt; &amp; &quot;quotes&quot; &lt;script&gt;x&lt;/script&gt;</div>',
  );
});

test("leading spaces, runs of spaces and tabs survive HTML whitespace collapsing", () => {
  assert.equal(
    plainTextHtml(" one  two   three\tfour"),
    '<div dir="ltr">&nbsp;one&nbsp; two&nbsp;&nbsp; three&nbsp;&nbsp;&nbsp; four</div>',
  );
  assert.equal(
    plainTextHtml("NBSP: kept, emoji 👩‍💻 kept"),
    '<div dir="ltr">NBSP: kept, emoji 👩‍💻 kept</div>',
  );
});

test("http(s) URLs become links without the punctuation that ends a sentence", () => {
  assert.equal(
    plainTextHtml(
      "See https://portfolio.example.test. Or (https://example.com/a?b=1&c=2), https://en.wikipedia.org/wiki/Foo_(bar)!",
    ),
    '<div dir="ltr">See <a href="https://portfolio.example.test">https://portfolio.example.test</a>. Or (<a href="https://example.com/a?b=1&amp;c=2">https://example.com/a?b=1&amp;c=2</a>), <a href="https://en.wikipedia.org/wiki/Foo_(bar)">https://en.wikipedia.org/wiki/Foo_(bar)</a>!</div>',
  );
  assert.equal(
    plainTextHtml("not a link: https://. or portfolio.example.test"),
    '<div dir="ltr">not a link: https://. or portfolio.example.test</div>',
  );
});
