import { useState } from "react";

/** Plain text copying; application tracking remains in the autofill workflow. */
export function useTextCopy(onError: (message: string) => void) {
  const [copied, setCopied] = useState("");
  async function copy(value: string, id: string) {
    try { await navigator.clipboard.writeText(value); setCopied(id); }
    catch { onError("Clipboard access failed. Select the text below to copy it."); }
  }
  return { copied, copy };
}
