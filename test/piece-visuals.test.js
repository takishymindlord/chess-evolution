import test from 'node:test';
import assert from 'node:assert/strict';
import { getPieceVisualMode, hasMaximumHybridCapabilities } from '../public/piece-visuals.js';

test('maximum hybrid resolves to star in Icons mode', () => {
  const piece = { type: 'queen', powers: ['rook', 'bishop', 'knight'] };
  assert.equal(hasMaximumHybridCapabilities(piece), true);
  assert.equal(getPieceVisualMode(piece, 'icons'), 'star');
});

test('maximum hybrid resolves to the same star in Merged mode', () => {
  const piece = { type: 'queen', powers: ['rook', 'bishop', 'knight'] };
  assert.equal(getPieceVisualMode(piece, 'merged'), 'star');
});

test('a pawn with all four acquired movement capabilities also becomes a star', () => {
  const piece = { type: 'pawn', powers: ['queen', 'rook', 'bishop', 'knight'] };
  assert.equal(getPieceVisualMode(piece, 'icons'), 'star');
  assert.equal(getPieceVisualMode(piece, 'merged'), 'star');
});

test('incomplete hybrids retain the selected visual style', () => {
  const piece = { type: 'rook', powers: ['knight', 'bishop'] };
  assert.equal(getPieceVisualMode(piece, 'icons'), 'icons');
  assert.equal(getPieceVisualMode(piece, 'merged'), 'merged');
});

test('kings remain ordinary kings in both visual styles', () => {
  const piece = { type: 'king', powers: ['queen', 'rook', 'bishop', 'knight'] };
  assert.equal(getPieceVisualMode(piece, 'icons'), 'icons');
  assert.equal(getPieceVisualMode(piece, 'merged'), 'icons');
  assert.equal(hasMaximumHybridCapabilities(piece), false);
});
