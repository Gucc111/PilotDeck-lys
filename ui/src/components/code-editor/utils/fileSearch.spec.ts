import { describe, expect, it } from 'vitest';
import { findTextSearchMatches } from './fileSearch';

describe('findTextSearchMatches', () => {
  it('finds case-insensitive text and preserves source offsets', () => {
    expect(findTextSearchMatches('PilotDeck pilotdeck', 'PILOT')).toEqual([
      { from: 0, to: 5 },
      { from: 10, to: 15 },
    ]);
  });

  it('finds Chinese text and ignores an empty query', () => {
    expect(findTextSearchMatches('搜索所有文件，文件搜索', '文件')).toEqual([
      { from: 4, to: 6 },
      { from: 7, to: 9 },
    ]);
    expect(findTextSearchMatches('searchable', '   ')).toEqual([]);
  });
});
