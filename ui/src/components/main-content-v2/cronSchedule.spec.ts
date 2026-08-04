import { describe, expect, it } from 'vitest';
import {
  buildSimpleCronExpression,
  getYearlyMonthDayCount,
  parseSimpleCronExpression,
} from './cronSchedule';

describe('buildSimpleCronExpression', () => {
  it('builds daily, weekly, monthly, and yearly expressions', () => {
    expect(buildSimpleCronExpression({ mode: 'daily', time: '08:30' })).toBe('30 8 * * *');
    expect(buildSimpleCronExpression({ mode: 'weekly', time: '08:30', weekday: 1 })).toBe('30 8 * * 1');
    expect(buildSimpleCronExpression({ mode: 'monthly', time: '08:30', dayOfMonth: 15 })).toBe('30 8 15 * *');
    expect(buildSimpleCronExpression({ mode: 'yearly', time: '08:30', dayOfMonth: 15, monthOfYear: 9 })).toBe('30 8 15 9 *');
  });

  it('supports boundary times and Sunday', () => {
    expect(buildSimpleCronExpression({ mode: 'daily', time: '00:00' })).toBe('0 0 * * *');
    expect(buildSimpleCronExpression({ mode: 'weekly', time: '23:59', weekday: 0 })).toBe('59 23 * * 0');
  });

  it('rejects invalid standard schedule values', () => {
    expect(() => buildSimpleCronExpression({ mode: 'daily', time: '24:00' })).toThrow();
    expect(() => buildSimpleCronExpression({ mode: 'weekly', time: '08:30', weekday: 7 })).toThrow();
    expect(() => buildSimpleCronExpression({ mode: 'monthly', time: '08:30', dayOfMonth: 32 })).toThrow();
    expect(() => buildSimpleCronExpression({ mode: 'yearly', time: '08:30', dayOfMonth: 31, monthOfYear: 4 })).toThrow();
    expect(() => buildSimpleCronExpression({ mode: 'yearly', time: '08:30', dayOfMonth: 29, monthOfYear: 2 })).toThrow();
  });
});

describe('parseSimpleCronExpression', () => {
  it.each([
    ['30 8 * * *', { mode: 'daily', time: '08:30' }],
    ['30 8 * * 1', { mode: 'weekly', time: '08:30', weekday: 1 }],
    ['30 8 15 * *', { mode: 'monthly', time: '08:30', dayOfMonth: 15 }],
    ['30 8 15 9 *', { mode: 'yearly', time: '08:30', dayOfMonth: 15, monthOfYear: 9 }],
  ])('parses a supported standard expression: %s', (expression, expected) => {
    expect(parseSimpleCronExpression(expression)).toEqual(expected);
  });

  it('normalizes whitespace, leading zeros, and Sunday 7 through a round trip', () => {
    const parsed = parseSimpleCronExpression('  05   09 * * 7  ');
    expect(parsed).toEqual({ mode: 'weekly', time: '09:05', weekday: 0 });
    expect(buildSimpleCronExpression(parsed!)).toBe('5 9 * * 0');
  });

  it.each([
    '',
    '* * * * *',
    '* 9 * * *',
    '0 * * * *',
    '*/15 9 * * *',
    '0 9,18 * * *',
    '0 9 * * 1,3',
    '0 9 * * 1-5',
    '0 9 15 * 1',
    '0 9 * 9 *',
    '0 9 31 4 *',
    '0 9 29 2 *',
    '60 9 * * *',
    '0 24 * * *',
    '0 9 32 * *',
    '0 9 1 13 *',
    '0 9 * * 8',
    '0 9 * * MON',
    '@daily',
    '0 9 * *',
    '0 9 * * * *',
    '5abc 9 * * *',
  ])('rejects an expression outside the four standard rules: %s', (expression) => {
    expect(parseSimpleCronExpression(expression)).toBeUndefined();
  });
});

describe('yearly dates', () => {
  it('excludes February 29 from standard yearly schedules', () => {
    expect(getYearlyMonthDayCount(2)).toBe(28);
    expect(getYearlyMonthDayCount(4)).toBe(30);
    expect(getYearlyMonthDayCount(12)).toBe(31);
  });
});
