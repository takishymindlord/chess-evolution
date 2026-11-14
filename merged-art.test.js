import test from 'node:test';
import assert from 'node:assert/strict';
import { mergedPieceSvg } from '../public/merged-art.js';

test('hybrid pieces render one full-size fused SVG rather than corner badges', () => {
  const markup = mergedPieceSvg({ id: 'hybrid-1', color: 'white', type: 'queen', powers: ['bishop'] });
  assert.match(markup, /<svg class="merged-art"/);
  assert.match(markup, /fusion-crown/);
  assert.match(markup, /fusion-bishop-inlay/);
  assert.doesNotMatch(markup, /merged-additions|power-badge|merged-original/);
});

test('queen and knight inheritance fuses a crown into a knight silhouette', () => {
  const markup = mergedPieceSvg({ id: 'hybrid-2', color: 'black', type: 'queen', powers: ['knight'] });
  assert.match(markup, /fusion-crown/);
  assert.match(markup, /translate\(13 0\) scale\(\.82 \.86\)/);
  assert.match(markup, /M28 83 C22 78 22 70/);
});

test('rook and bishop inheritance combines a bishop form with a rook battlement band', () => {
  const markup = mergedPieceSvg({ id: 'hybrid-3', color: 'white', type: 'bishop', powers: ['rook'] });
  assert.match(markup, /fusion-rook-band/);
  assert.match(markup, /M50 9 C64 21 68 31/);
});

test('the four special movement capabilities retain the star maximum form', () => {
  const markup = mergedPieceSvg({ id: 'hybrid-4', color: 'white', type: 'queen', powers: ['rook', 'bishop', 'knight'] });
  assert.match(markup, /merged-star/);
  assert.match(markup, /✦/);
  assert.doesNotMatch(markup, /<svg/);
});

test('kings never receive merged artwork', () => {
  assert.equal(mergedPieceSvg({ id: 'king-1', color: 'white', type: 'king', powers: ['queen', 'rook', 'bishop', 'knight'] }), '');
});
