import test from 'node:test';
import assert from 'node:assert/strict';
import { allLegalMoves, applyGeneratedMove, createInitialState, getGameStatus, playMove } from '../public/engine.js';
import { evaluatePosition, findBestMove } from '../public/ai.js';

function makeTacticalState() {
  const state = createInitialState();
  state.board = Array.from({ length: 8 }, () => Array(8).fill(null));
  state.board[7][4] = { id: 'wk', color: 'white', type: 'king', powers: [], captures: [], hasMoved: false };
  state.board[0][4] = { id: 'bk', color: 'black', type: 'king', powers: [], captures: [], hasMoved: false };
  state.board[7][0] = { id: 'wr', color: 'white', type: 'rook', powers: [], captures: [], hasMoved: false };
  state.board[1][0] = { id: 'bn', color: 'black', type: 'knight', powers: [], captures: [], hasMoved: false };
  state.turn = 'white';
  state.enPassant = null;
  state.moveNumber = 1;
  state.history = [];
  state.captured = { white: [], black: [] };
  state.lastMove = null;
  state.status = 'active';
  state.winner = null;
  state.check = null;
  state.gameOver = false;
  return state;
}

test('AI returns a legal move from the initial position without mutating it', () => {
  const state = createInitialState();
  const beforeTurn = state.turn;
  const beforeMoves = allLegalMoves(state).length;

  const result = findBestMove(state, { depth: 1, timeLimitMs: 1000, maxNodes: 10_000 });

  assert.ok(result.move, 'AI should return a move');
  assert.ok(allLegalMoves(state).some((move) =>
    move.from.x === result.move.from.x &&
    move.from.y === result.move.from.y &&
    move.to.x === result.move.to.x &&
    move.to.y === result.move.to.y
  ), 'AI move should be legal');
  assert.equal(state.turn, beforeTurn);
  assert.equal(allLegalMoves(state).length, beforeMoves);
  assert.ok(result.nodes > 0);
});

test('AI prefers a free capture and recognizes the inherited knight power', () => {
  const state = makeTacticalState();
  const result = findBestMove(state, { depth: 1, timeLimitMs: 1500, maxNodes: 20_000 });

  assert.ok(result.move);
  assert.deepEqual(result.move.from, { x: 0, y: 7 });
  assert.deepEqual({ x: result.move.to.x, y: result.move.to.y }, { x: 0, y: 1 });
});

test('evaluation values inherited movement powers without counting duplicates twice', () => {
  const state = makeTacticalState();
  const base = evaluatePosition(state);
  state.board[7][0].powers = ['knight'];
  const oneKnightPower = evaluatePosition(state);
  state.board[7][0].powers = ['knight', 'knight'];
  const duplicatedKnightPower = evaluatePosition(state);

  assert.ok(oneKnightPower > base);
  assert.equal(duplicatedKnightPower, oneKnightPower);
});

test('AI also searches correctly when Black is the side to move', () => {
  const state = createInitialState();
  playMove(state, { x: 4, y: 6 }, { x: 4, y: 4 });
  const result = findBestMove(state, { depth: 1, timeLimitMs: 1000, maxNodes: 10_000 });
  assert.ok(result.move, 'AI should return a move for Black');
  assert.ok(allLegalMoves(state, 'black').some((move) =>
    move.from.x === result.move.from.x &&
    move.from.y === result.move.from.y &&
    move.to.x === result.move.to.x &&
    move.to.y === result.move.to.y
  ), 'Black AI move should be legal');
});


test('AI search move application performs capture inheritance in simulated positions', () => {
  const state = makeTacticalState();
  const capture = allLegalMoves(state).find((move) =>
    move.from.x === 0 && move.from.y === 7 && move.to.x === 0 && move.to.y === 1
  );
  assert.ok(capture, 'the rook should have the test capture available');
  applyGeneratedMove(state, capture);
  const evolvedRook = state.board[1][0];
  assert.equal(evolvedRook.type, 'rook');
  assert.ok(evolvedRook.powers.includes('knight'), 'the simulated rook should inherit the knight movement');
  assert.equal(state.turn, 'black');
});

function makeEmptyState() {
  const state = createInitialState();
  state.board = Array.from({ length: 8 }, () => Array(8).fill(null));
  state.turn = 'white';
  state.enPassant = null;
  state.moveNumber = 1;
  state.history = [];
  state.captured = { white: [], black: [] };
  state.lastMove = null;
  state.status = 'active';
  state.winner = null;
  state.check = null;
  state.gameOver = false;
  return state;
}

function putPiece(state, id, color, type, x, y, powers = []) {
  state.board[y][x] = { id, color, type, powers, captures: [], hasMoved: true };
}

test('AI finds a forced checkmate in one move', async () => {
  const { getGameStatus } = await import('../public/engine.js');
  const state = makeEmptyState();
  putPiece(state, 'wk', 'white', 'king', 5, 2);
  putPiece(state, 'bk', 'black', 'king', 7, 0);
  putPiece(state, 'wq', 'white', 'queen', 6, 2);

  const result = findBestMove(state, { depth: 3, timeLimitMs: 1500, maxNodes: 30_000 });
  assert.deepEqual(result.move.from, { x: 6, y: 2 });
  assert.deepEqual({ x: result.move.to.x, y: result.move.to.y }, { x: 6, y: 1 });
  assert.ok(result.score >= 99_000, 'a forced mate should receive a mate-range score');

  applyGeneratedMove(state, result.move);
  assert.deepEqual(getGameStatus(state), {
    status: 'checkmate', winner: 'white', check: 'black', gameOver: true
  });
});

test('quiescence search avoids a poisoned rook capture that loses the rook immediately', () => {
  const state = makeEmptyState();
  putPiece(state, 'wk', 'white', 'king', 7, 7);
  putPiece(state, 'bk', 'black', 'king', 7, 0);
  putPiece(state, 'wr', 'white', 'rook', 0, 6);
  putPiece(state, 'bp', 'black', 'pawn', 0, 1);
  putPiece(state, 'br', 'black', 'rook', 0, 0);
  putPiece(state, 'wn', 'white', 'knight', 2, 5);

  const result = findBestMove(state, { depth: 1, timeLimitMs: 1500, maxNodes: 20_000 });
  assert.ok(result.move);
  assert.notDeepEqual(result.move, {
    from: { x: 0, y: 6 }, to: { x: 0, y: 1 }
  }, 'the AI should see that the pawn capture loses its rook to the recapture');
  assert.ok(result.qNodes > 0, 'quiescence nodes should be searched');
});

test('evaluation penalizes an exposed evolved unit more than a safe one', () => {
  const makeExposureState = (attacked) => {
    const state = makeEmptyState();
    putPiece(state, 'wk', 'white', 'king', 0, 7);
    putPiece(state, 'bk', 'black', 'king', 7, 0);
    putPiece(state, 'wr', 'white', 'rook', 3, 4, ['knight']);
    putPiece(state, 'br', 'black', 'rook', attacked ? 3 : 5, 0);
    return state;
  };

  const exposedScore = evaluatePosition(makeExposureState(true));
  const safeScore = evaluatePosition(makeExposureState(false));
  assert.ok(safeScore > exposedScore, `safe hybrid score ${safeScore} should exceed exposed score ${exposedScore}`);
});

test('transposition table recognizes repeated positions reached by different move orders', () => {
  const state = makeEmptyState();
  putPiece(state, 'wk', 'white', 'king', 0, 7);
  putPiece(state, 'bk', 'black', 'king', 7, 0);
  putPiece(state, 'wn1', 'white', 'knight', 1, 7);
  putPiece(state, 'wn2', 'white', 'knight', 6, 7);
  putPiece(state, 'bn1', 'black', 'knight', 1, 0);
  putPiece(state, 'bn2', 'black', 'knight', 6, 0);

  const result = findBestMove(state, { depth: 5, timeLimitMs: 2000, maxNodes: 50_000 });
  assert.ok(result.move);
  assert.ok(result.ttHits > 0, 'search should reuse transposed positions');
});


test('AI recognizes the checkmating finish from the supplied 31-move match', () => {
  const state = createInitialState();
  const movesBeforeMate = [
    ['d2', 'd4'], ['e7', 'e6'], ['e2', 'e4'], ['g8', 'f6'], ['e4', 'e5'],
    ['f6', 'e4'], ['f2', 'f4'], ['f7', 'f6'], ['b1', 'c3'], ['f6', 'e5'],
    ['c3', 'e4'], ['f8', 'd6'], ['d1', 'h5'], ['g7', 'g6'], ['h5', 'g5'],
    ['d8', 'g5'], ['f4', 'g5'], ['h8', 'f8'], ['e4', 'd6'], ['c7', 'd6'],
    ['f1', 'd3'], ['d6', 'b4'], ['e1', 'd1'], ['f8', 'f1'], ['d3', 'f1'],
    ['b8', 'c6'], ['g5', 'e5'], ['c6', 'e5'], ['d4', 'e5'], ['b4', 'd5']
  ];
  const toCoords = (square) => ({ x: square.charCodeAt(0) - 97, y: 8 - Number(square[1]) });

  for (const [from, to] of movesBeforeMate) playMove(state, toCoords(from), toCoords(to));
  assert.equal(state.turn, 'white');

  const result = findBestMove(state, { depth: 3, timeLimitMs: 1500, maxNodes: 40_000 });
  assert.deepEqual(result.move.from, toCoords('e5'));
  assert.deepEqual({ x: result.move.to.x, y: result.move.to.y }, toCoords('f7'));
  assert.ok(result.score >= 99_000, 'the final move should be scored as a forced mate');

  playMove(state, result.move.from, result.move.to);
  assert.deepEqual(getGameStatus(state), {
    status: 'checkmate', winner: 'white', check: 'black', gameOver: true
  });
});

test('evaluation rewards friendly protection around an evolved unit', () => {
  const makeSupportedState = (bishopX, bishopY) => {
    const state = makeEmptyState();
    putPiece(state, 'wk', 'white', 'king', 0, 7);
    putPiece(state, 'bk', 'black', 'king', 7, 0);
    putPiece(state, 'wr', 'white', 'rook', 3, 4, ['knight']);
    putPiece(state, 'wb', 'white', 'bishop', bishopX, bishopY);
    return state;
  };

  const protectedScore = evaluatePosition(makeSupportedState(2, 5)); // c3 bishop defends d4 rook
  const unsupportedScore = evaluatePosition(makeSupportedState(2, 6)); // c2 bishop does not defend d4
  assert.ok(protectedScore > unsupportedScore);
});
