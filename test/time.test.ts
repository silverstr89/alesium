import { expect, test } from 'vitest';
import { tradingDay } from '../src/time.ts';

test('the trading day starts at 00:00 Nicosia', () => {
  expect(tradingDay(new Date('2026-01-15T21:59:59Z'))).toBe('2026-01-15');
  expect(tradingDay(new Date('2026-01-15T22:00:00Z'))).toBe('2026-01-16');
});

test('in summer the trading day starts at 21:00 UTC (Nicosia is UTC+3)', () => {
  expect(tradingDay(new Date('2026-07-15T20:59:59Z'))).toBe('2026-07-15');
  expect(tradingDay(new Date('2026-07-15T21:00:00Z'))).toBe('2026-07-16');
});

test('the day boundary follows the switch to and from summer time', () => {
  expect(tradingDay(new Date('2026-03-29T20:59:59Z'))).toBe('2026-03-29'); // summer time since 01:00 UTC
  expect(tradingDay(new Date('2026-03-29T21:00:00Z'))).toBe('2026-03-30');
  expect(tradingDay(new Date('2026-10-25T21:59:59Z'))).toBe('2026-10-25'); // winter time since 01:00 UTC
  expect(tradingDay(new Date('2026-10-25T22:00:00Z'))).toBe('2026-10-26');
});
