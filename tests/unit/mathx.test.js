import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractNumbers, summarize, evaluate, inlineCalc, formatNumber } from '../../app/js/mathx.js';

test('extracts numbers from lists, money, negatives; skips dates, times and list markers', () => {
  assert.deepEqual(extractNumbers('- milk $3.50\n- eggs 2\n1. rent $1,200\non 2026-10-01 at 10:30 lost -4, 50% off'), [3.5, 2, 1200, -4]);
});

test('summarize', () => {
  const s = summarize([10, 5, 2]);
  assert.equal(s.sum, 17);
  assert.equal(s.difference, 3);
  assert.equal(s.product, 100);
  assert.equal(s.quotient, 1);
  assert.equal(s.min, 2);
  assert.equal(summarize([]), null);
});

test('evaluate respects precedence, powers, unary minus and functions', () => {
  assert.equal(evaluate('2+3*4'), 14);
  assert.equal(evaluate('(2+3)*4'), 20);
  assert.equal(evaluate('-2^2'), -4);
  assert.equal(evaluate('2^3^2'), 512);
  assert.equal(evaluate('sqrt(16)+max(1,5)'), 9);
  assert.equal(evaluate('$1,200 × 3'), 3600);
  assert.equal(evaluate('10 ÷ 4'), 2.5);
  assert.throws(() => evaluate('2 +'));
});

test('inline "=" calculations only trigger on real expressions', () => {
  assert.equal(inlineCalc('groceries 12*4 + 3 =').value, 51);
  assert.equal(inlineCalc('total: 5+5=').text, '10');
  assert.equal(inlineCalc('x ='), null);
  assert.equal(inlineCalc('I think 3 ='), null);
  assert.equal(inlineCalc('sum(1,2,3)=').value, 6);
});

test('formatNumber trims float noise', () => {
  assert.equal(formatNumber(0.1 + 0.2), '0.3');
  assert.equal(formatNumber(NaN), '—');
});
