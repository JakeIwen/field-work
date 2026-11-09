type OpeningIdentity = {
  company?: string;
  title?: string;
  url?: string;
  id?: string;
};

export function openingErrorMessage(
  opening: OpeningIdentity | undefined,
  error: unknown,
): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!opening) return message;
  const label =
    [opening.company, opening.title].filter(Boolean).join(" · ") ||
    opening.url ||
    opening.id;
  if (!label) return message;
  const prefix = `${label}: `;
  return message.startsWith(prefix) ? message : prefix + message;
}
