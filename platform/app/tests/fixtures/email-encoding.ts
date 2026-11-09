/** Characters that commonly break between a browser text box and a delivered email. */
export const encodingProbe = [
  "Hi Zoë and the Ångström team,",
  "",
  "Curly quotes “like this” and ‘these’, an en dash – an em dash — and an ellipsis…",
  "Accents: café, naïve, résumé, São Paulo, Kraków, Düsseldorf, Ñandú.",
  "Symbols: € £ ¥ © ® ™ ° ± × ÷ ≈ ≠ ≤ ≥ → ← ✓ • ½ ¼",
  "CJK and RTL: 日本語のテキスト, 한국어, 中文, עברית, العربية",
  "Emoji: 👋🏽 🚐 👩‍💻 🇺🇸 ❤️ (combining: é vs é, NBSP: here, zero-width joiner‍)",
  "Math 𝔘𝔫𝔦𝔠𝔬𝔡𝔢 and a tab:\tdone. Equals = signs =3D and a soft break =",
  ".A line starting with a dot",
  "From the start of a line (mbox escaping must not apply)",
  "Trailing spaces stay   ",
  `${"A very long line without breaks ".repeat(12)}end.`,
  "",
  "Best,",
  "Sam Rivera",
].join("\n");
export const encodingSubject =
  "Following up — café “résumé” 👋🏽 日本語 application for the Ångström role";
