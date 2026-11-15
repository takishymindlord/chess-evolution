import test from 'node:test';
import assert from 'node:assert/strict';
import { originalMoveDelay, scaledMoveDelay, formatElapsed } from '../public/game-replay.js';

const moves = [
  { playedAt: 1500 },
  { playedAt: 3500 },
  { playedAt: 7500 }
];

test('original replay timing preserves the actual gap from game start and between moves', () => {
  assert.equal(originalMoveDelay(moves, 0, 1000), 500);
  assert.equal(originalMoveDelay(moves, 1, 1000), 2000);
  assert.equal(originalMoveDelay(moves, 2, 1000), 4000);
});

test('replay speed changes scale original delays without losing their timing basis', () => {
  assert.equal(scaledMoveDelay(moves, 2, 1000, '0.5'), 8000);
  assert.equal(scaledMoveDelay(moves, 2, 1000, 'original'), 4000);
  assert.equal(scaledMoveDelay(moves, 2, 1000, '2'), 2000);
  assert.equal(scaledMoveDelay(moves, 2, 1000, '4'), 1000);
});

test('invalid or missing historical timestamps use the safe fallback interval', () => {
  assert.equal(originalMoveDelay([{ playedAt: 900 }], NaN, NaN, 700), 700);
  assert.equal(originalMoveDelay([{ playedAt: 900 }], 0, NaN, 700), 700);
});

test('elapsed replay time is formatted for a compact match timeline', () => {
  assert.equal(formatElapsed(0), '0:00');
  assert.equal(formatElapsed(61500), '1:01');
  assert.equal(formatElapsed(3661000), '1:01:01');
});
