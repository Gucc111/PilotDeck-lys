export type TextSearchMatch = {
  from: number;
  to: number;
};

type FoldedText = {
  value: string;
  starts: number[];
  ends: number[];
};

function foldTextWithSourceOffsets(text: string): FoldedText {
  let value = '';
  const starts: number[] = [];
  const ends: number[] = [];

  for (let sourceIndex = 0; sourceIndex < text.length;) {
    const codePoint = text.codePointAt(sourceIndex);
    if (codePoint === undefined) break;
    const sourceCharacter = String.fromCodePoint(codePoint);
    const sourceEnd = sourceIndex + sourceCharacter.length;
    // Upper-then-lower provides a context-independent case fold (for example,
    // it treats the two Greek sigma forms alike) while the offset arrays keep
    // expansions such as `İ` and `ß` mapped to their original character.
    const foldedCharacter = sourceCharacter.toUpperCase().toLowerCase();
    value += foldedCharacter;
    for (let foldedIndex = 0; foldedIndex < foldedCharacter.length; foldedIndex += 1) {
      starts.push(sourceIndex);
      ends.push(sourceEnd);
    }
    sourceIndex = sourceEnd;
  }

  return { value, starts, ends };
}

export function findTextSearchMatches(text: string, query: string): TextSearchMatch[] {
  const normalizedQuery = foldTextWithSourceOffsets(query.trim()).value;
  if (!normalizedQuery) return [];

  const foldedText = foldTextWithSourceOffsets(text);
  const matches: TextSearchMatch[] = [];
  let searchOffset = 0;

  while (searchOffset <= foldedText.value.length - normalizedQuery.length) {
    const index = foldedText.value.indexOf(normalizedQuery, searchOffset);
    if (index < 0) break;
    const lastFoldedIndex = index + normalizedQuery.length - 1;
    const match = {
      from: foldedText.starts[index],
      to: foldedText.ends[lastFoldedIndex],
    };
    const previous = matches[matches.length - 1];
    if (!previous || previous.from !== match.from || previous.to !== match.to) {
      matches.push(match);
    }
    searchOffset = index + Math.max(1, normalizedQuery.length);
  }

  return matches;
}
