
export const entityUrl = (prefix: string, id: string) =>
  `${prefix}/${encodeURIComponent(id)}`;
