/** read_job_search_source returns a whole captured source, up to this size. */
export const maxContextSourceBytes = 800_000;

/*
 * Claude Code moves an MCP result to a file once it passes 50,000 characters
 * or 25,000 tokens, and purpose tasks cannot open files, so AGENTS.md and the
 * evidence dossier never reached the model. Each Fieldwork tool declares the
 * largest result Claude Code accepts inline, and sessions raise the token cap
 * to cover any source the read tool returns (at most a token per three bytes).
 */
export const claudeToolResultChars = 500_000;
export const maxContextSourceTokens = Math.ceil(maxContextSourceBytes / 3);
