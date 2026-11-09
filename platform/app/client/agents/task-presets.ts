
export const presets: Record<string, { title: string; prompt: string }> = {
  "resume-revision": {
    title: "Revise a resume",
    prompt:
      "Review the selected resume against the current evidence dossier and repository instructions. Propose one focused improvement that strengthens credible engineering evidence. Work in an isolated draft revision bundle, preserve the current resume and earlier versions, update the draft Markdown and evidence as needed, keep private/public content synchronized with only the phone omitted publicly, and run the existing validation tools. Report changed artifacts, validation results and any unresolved questions. Do not promote the draft to current.",
  },
  "cover-letter": {
    title: "Tailor an application",
    prompt:
      "Prepare a concise cover letter for the selected opening using the selected resume, current evidence dossier and repository writing guidelines. Explain the strongest specific overlaps and relevant engineering judgment without restating resume bullets. Keep unsupported claims out. Preserve the draft and show its source evidence. Do not send an application or contact the employer.",
  },
  "job-fit": {
    title: "Review an opening",
    prompt:
      "Evaluate this opening against my current resume and complete evidence dossier, including supported AI work. Focus on technical fit, production ownership, schedule autonomy, actual hours, on-call, US remote mobility and published base compensation. Preserve geographic bands and distinguish facts from unknowns. Identify the questions worth asking a recruiter. Do not equate lower pay with less work.",
  },
  "company-research": {
    title: "Refresh company research",
    prompt:
      "Refresh research for the selected company using current official sources. Check current relevant senior engineering openings and work policies; retain dated evidence and access failures. Apply the repository monitoring criteria, preserve stable identities and source history, and update the appropriate research sources. A failed careers page does not establish that jobs closed. Do not add or remove monitored companies without my explicit instruction.",
  },
};
