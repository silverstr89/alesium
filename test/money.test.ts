import { expect, test } from 'vitest';
import { fromMicros, mulDiv, roundToCents, toMicros } from '../src/money.ts';

test('parses and prints decimals', () => {
  expect(toMicros('1.2345')).toBe(1_234_500n);
  expect(toMicros('-0.000001')).toBe(-1n);
  expect(fromMicros(-1_234_500n)).toBe('-1.234500');
  expect(() => toMicros('1.0000001')).toThrow();
});

test('rounds half away from zero', () => {
  expect(mulDiv(5n, 1n, 2n)).toBe(3n);
  expect(mulDiv(-5n, 1n, 2n)).toBe(-3n);
  expect(roundToCents(toMicros('0.125'))).toBe(toMicros('0.13'));
  expect(roundToCents(toMicros('-0.125'))).toBe(toMicros('-0.13'));
});
