import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, getLegalMoves, playMove, allLegalMoves } from '../public/engine.js';

function customState(pieces, turn = 'white') {
  const state = createInitialState();
  state.board = Array.from({ length: 8 }, () => Array(8).fill(null));
  for (const piece of pieces) {
    state.board[piece.y][piece.x] = {
      id: piece.id || `${piece.color}-${piece.type}-${piece.x}${piece.y}`,
      color: piece.color,
      type: piece.type,
      powers: [...(piece.powers || [])],
      captures: structuredClone(piece.captures || []),
      hasMoved: piece.hasMoved ?? true
    };
  }
  state.turn = turn;
  state.enPassant = null;
  state.history = [];
  state.captured = { white: [], black: [] };
  state.status = 'active';
  state.winner = null;
  state.check = null;
  state.gameOver = false;
  return state;
}

test('initial position has the orthodox 20 legal moves', () => {
  const state = createInitialState();
  assert.equal(allLegalMoves(state).length, 20);
});

test('captures inherit the victim type and its entire accumulated lineage', () => {
  const state = customState([
    { x: 7, y: 7, color: 'white', type: 'king' },
    { x: 7, y: 0, color: 'black', type: 'king' },
    { x: 2, y: 7, color: 'white', type: 'queen' },
    { x: 2, y: 6, color: 'black', type: 'knight', powers: ['bishop', 'bishop'] },
    { x: 3, y: 6, color: 'black', type: 'rook' }
  ]);
  playMove(state, { x: 2, y: 7 }, { x: 2, y: 6 });
  assert.deepEqual(state.board[6][2].powers, ['knight', 'bishop']);
  assert.equal(state.board[6][2].captures.length, 1);
  assert.equal(state.board[6][2].captures[0].type, 'knight');
  playMove(state, { x: 3, y: 6 }, { x: 2, y: 6 });
  assert.equal(state.board[6][2].type, 'rook');
  assert.deepEqual(state.board[6][2].powers, ['queen', 'knight', 'bishop']);
  assert.equal(state.board[6][2].captures.length, 1);
  assert.equal(state.board[6][2].captures[0].type, 'queen');
  assert.equal(state.board[6][2].captures[0].captures[0].type, 'knight');
});

test('capturing an unpowered pawn grants no pawn movement', () => {
  const state = customState([
    { x: 7, y: 7, color: 'white', type: 'king' },
    { x: 7, y: 0, color: 'black', type: 'king' },
    { x: 2, y: 7, color: 'white', type: 'queen' },
    { x: 2, y: 6, color: 'black', type: 'pawn' }
  ]);
  playMove(state, { x: 2, y: 7 }, { x: 2, y: 6 });
  assert.deepEqual(state.board[6][2].powers, []);
});

test('capturing a powered-up pawn transfers its special powers but not pawn movement', () => {
  const state = customState([
    { x: 7, y: 7, color: 'white', type: 'king' },
    { x: 7, y: 0, color: 'black', type: 'king' },
    { x: 2, y: 7, color: 'white', type: 'queen' },
    { x: 2, y: 6, color: 'black', type: 'pawn', powers: ['knight', 'bishop'] }
  ]);
  playMove(state, { x: 2, y: 7 }, { x: 2, y: 6 });
  assert.deepEqual(state.board[6][2].powers, ['knight', 'bishop']);
});

test('a pawn can use an inherited knight move while keeping its pawn identity', () => {
  const state = customState([
    { x: 7, y: 7, color: 'white', type: 'king' },
    { x: 7, y: 0, color: 'black', type: 'king' },
    { x: 1, y: 4, color: 'white', type: 'pawn' },
    { x: 2, y: 3, color: 'black', type: 'knight' }
  ]);
  playMove(state, { x: 1, y: 4 }, { x: 2, y: 3 });
  state.turn = 'white';
  const pawn = state.board[3][2];
  assert.equal(pawn.type, 'pawn');
  assert.ok(pawn.powers.includes('knight'));
  assert.ok(getLegalMoves(state, 2, 3).some((move) => move.x === 3 && move.y === 1));
});


test('capturing a duplicate capability does not add a second copy', () => {
  const state = customState([
    { x: 7, y: 7, color: 'white', type: 'king' },
    { x: 7, y: 0, color: 'black', type: 'king' },
    { x: 2, y: 7, color: 'white', type: 'rook', powers: ['knight'] },
    { x: 2, y: 6, color: 'black', type: 'knight' }
  ]);
  const { record } = playMove(state, { x: 2, y: 7 }, { x: 2, y: 6 });
  assert.deepEqual(state.board[6][2].powers, ['knight']);
  assert.deepEqual(record.inherited, []);
  assert.equal(state.board[6][2].captures.length, 1);
});


test('the king never inherits movement powers from captures', () => {
  const state = customState([
    { x: 4, y: 7, color: 'white', type: 'king' },
    { x: 4, y: 0, color: 'black', type: 'king' },
    { x: 4, y: 6, color: 'black', type: 'rook' }
  ]);
  playMove(state, { x: 4, y: 7 }, { x: 4, y: 6 });
  const king = state.board[6][4];
  assert.equal(king.type, 'king');
  assert.deepEqual(king.powers, []);
  assert.equal(getLegalMoves(state, 4, 6).some((move) => move.x === 4 && move.y === 4), false);
});

test('a captured evolved piece transfers its nested capture tree', () => {
  const state = customState([
    { x: 7, y: 7, color: 'white', type: 'king' },
    { x: 7, y: 0, color: 'black', type: 'king' },
    { x: 2, y: 7, color: 'white', type: 'queen' },
    { x: 2, y: 6, color: 'black', type: 'rook', powers: ['bishop'], captures: [
      { id: 'victim-1', color: 'white', type: 'knight', powers: [], captures: [
        { id: 'victim-2', color: 'black', type: 'bishop', powers: [], captures: [] }
      ] }
    ] }
  ]);
  playMove(state, { x: 2, y: 7 }, { x: 2, y: 6 });
  const surviving = state.board[6][2];
  assert.deepEqual(surviving.powers, ['rook', 'bishop']);
  assert.equal(surviving.captures.length, 1);
  assert.equal(surviving.captures[0].captures[0].type, 'knight');
  assert.equal(surviving.captures[0].captures[0].captures[0].type, 'bishop');
});
