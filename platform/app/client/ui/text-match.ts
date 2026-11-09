
export const textMatch = (q: string, ...parts: unknown[]) =>
  parts.join(" ").toLowerCase().includes(q.toLowerCase());
