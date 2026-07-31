export type TextSearchMatch = {
  from: number;
  to: number;
};

export function findTextSearchMatches(text: string, query: string): TextSearchMatch[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return [];

  const normalizedText = text.toLocaleLowerCase();
  const matches: TextSearchMatch[] = [];
  let searchOffset = 0;

  while (searchOffset <= normalizedText.length - normalizedQuery.length) {
    const index = normalizedText.indexOf(normalizedQuery, searchOffset);
    if (index < 0) break;
    matches.push({ from: index, to: index + normalizedQuery.length });
    searchOffset = index + Math.max(1, normalizedQuery.length);
  }

  return matches;
}
