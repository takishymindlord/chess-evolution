export const FILES = 'abcdefgh';
export const PIECE_NAMES = {
  king: 'King', queen: 'Queen', rook: 'Rook', bishop: 'Bishop', knight: 'Knight', pawn: 'Pawn'
};

const ORTHOGONAL = [[1,0],[-1,0],[0,1],[0,-1]];
const DIAGONAL = [[1,1],[1,-1],[-1,1],[-1,-1]];
const KNIGHT_STEPS = [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]];
const KING_STEPS = [...ORTHOGONAL, ...DIAGONAL];

const inBounds = (x, y) => x >= 0 && x < 8 && y >= 0 && y < 8;
const squareName = (x, y) => `${FILES[x]}${8 - y}`;
const clone = (value) => JSON.parse(JSON.stringify(value));

function makePiece(id, color, type) {
  return { id, color, type, powers: [], captures: [], hasMoved: false };
}

function uniquePowers(values, nativeType = null) {
  return [...new Set((values || []).filter((type) => type && type !== 'pawn' && type !== nativeType))];
}

export function getPositionKey(state) {
  const rows = state.board.map((row) => row.map((piece) => {
    if (!piece) return '--';
    const powers = piece.type === 'king' ? '' : [...new Set(piece.powers || [])].sort().join('.');
    const movementRight = ['king', 'rook', 'pawn'].includes(piece.type) ? (piece.hasMoved ? 1 : 0) : 0;
    return `${piece.color[0]}:${piece.type}:${movementRight}:${powers}`;
  }).join('|')).join('/');
  const ep = state.enPassant ? `${state.enPassant.x},${state.enPassant.y}` : '-';
  return `${state.turn};${ep};${rows}`;
}

export function createInitialState() {
  const board = Array.from({ length: 8 }, () => Array(8).fill(null));
  const backRank = ['rook', 'knight', 'bishop', 'queen', 'king', 'bishop', 'knight', 'rook'];
  let id = 1;
  for (let x = 0; x < 8; x++) {
    board[0][x] = makePiece(`p${id++}`, 'black', backRank[x]);
    board[1][x] = makePiece(`p${id++}`, 'black', 'pawn');
    board[6][x] = makePiece(`p${id++}`, 'white', 'pawn');
    board[7][x] = makePiece(`p${id++}`, 'white', backRank[x]);
  }
  const state = {
    board,
    startedAt: Date.now(),
    turn: 'white',
    enPassant: null,
    moveNumber: 1,
    history: [],
    captured: { white: [], black: [] },
    lastMove: null,
    status: 'active',
    winner: null,
    check: null,
    gameOver: false,
    drawReason: null,
    halfmoveClock: 0,
    positionCounts: {}
  };
  state.positionCounts[getPositionKey(state)] = 1;
  return state;
}

function movementTypes(piece) {
  // The king is deliberately immutable: it always has orthodox king movement
  // and can never acquire inherited movement powers.
  if (piece.type === 'king') return new Set(['king']);
  return new Set([piece.type, ...(piece.powers || [])].filter((type) => type !== 'pawn'));
}

function addIfAvailable(state, moves, x, y, color) {
  if (!inBounds(x, y)) return false;
  const target = state.board[y][x];
  if (target?.color === color || target?.type === 'king') return false;
  moves.push({ x, y });
  return !target;
}

function slideMoves(state, x, y, piece, directions, moves) {
  for (const [dx, dy] of directions) {
    let nx = x + dx;
    let ny = y + dy;
    while (inBounds(nx, ny)) {
      const target = state.board[ny][nx];
      if (target?.color === piece.color) break;
      if (target?.type === 'king') break;
      moves.push({ x: nx, y: ny });
      if (target) break;
      nx += dx;
      ny += dy;
    }
  }
}

function getPseudoMoves(state, x, y) {
  const piece = state.board[y]?.[x];
  if (!piece) return [];
  const moves = [];
  const types = movementTypes(piece);

  // A pawn always keeps its native pawn rules, even after collecting other powers.
  if (piece.type === 'pawn') {
    const direction = piece.color === 'white' ? -1 : 1;
    const startRow = piece.color === 'white' ? 6 : 1;
    const oneY = y + direction;
    if (inBounds(x, oneY) && !state.board[oneY][x]) {
      moves.push({ x, y: oneY });
      const twoY = y + direction * 2;
      if (y === startRow && !piece.hasMoved && !state.board[twoY][x]) {
        moves.push({ x, y: twoY, doublePawn: true });
      }
    }
    for (const dx of [-1, 1]) {
      const nx = x + dx;
      const ny = y + direction;
      if (!inBounds(nx, ny)) continue;
      const target = state.board[ny][nx];
      if ((target && target.color !== piece.color && target.type !== 'king') ||
          (state.enPassant && state.enPassant.x === nx && state.enPassant.y === ny)) {
        moves.push({ x: nx, y: ny, enPassant: !target });
      }
    }
  }

  if (types.has('rook') || types.has('queen')) slideMoves(state, x, y, piece, ORTHOGONAL, moves);
  if (types.has('bishop') || types.has('queen')) slideMoves(state, x, y, piece, DIAGONAL, moves);

  if (types.has('knight')) {
    for (const [dx, dy] of KNIGHT_STEPS) addIfAvailable(state, moves, x + dx, y + dy, piece.color);
  }
  if (types.has('king')) {
    for (const [dx, dy] of KING_STEPS) addIfAvailable(state, moves, x + dx, y + dy, piece.color);
  }

  // Remove duplicate destinations caused by overlapping inherited powers.
  const unique = new Map();
  for (const move of moves) {
    const key = `${move.x},${move.y}`;
    if (!unique.has(key)) unique.set(key, move);
    else if (move.enPassant || move.doublePawn) unique.set(key, { ...unique.get(key), ...move });
  }
  return [...unique.values()];
}

function getAttackSquares(state, x, y) {
  const piece = state.board[y]?.[x];
  if (!piece) return [];
  const squares = new Set();
  const types = movementTypes(piece);
  const add = (nx, ny) => { if (inBounds(nx, ny)) squares.add(`${nx},${ny}`); };

  // Pawn attacks are diagonal only. Its forward movement is never an attack.
  if (piece.type === 'pawn') {
    const direction = piece.color === 'white' ? -1 : 1;
    add(x - 1, y + direction);
    add(x + 1, y + direction);
  }

  const ray = (directions) => {
    for (const [dx, dy] of directions) {
      let nx = x + dx;
      let ny = y + dy;
      while (inBounds(nx, ny)) {
        add(nx, ny);
        if (state.board[ny][nx]) break;
        nx += dx;
        ny += dy;
      }
    }
  };
  if (types.has('rook') || types.has('queen')) ray(ORTHOGONAL);
  if (types.has('bishop') || types.has('queen')) ray(DIAGONAL);
  if (types.has('knight')) for (const [dx, dy] of KNIGHT_STEPS) add(x + dx, y + dy);
  if (types.has('king')) for (const [dx, dy] of KING_STEPS) add(x + dx, y + dy);
  return [...squares].map((key) => key.split(',').map(Number));
}

/** Return every square attacked by a side, using the same attack semantics as check detection. */
export function getAttackedSquares(state, byColor) {
  const attacked = new Set();
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const piece = state.board[y][x];
      if (piece?.color !== byColor) continue;
      for (const [ax, ay] of getAttackSquares(state, x, y)) attacked.add(`${ax},${ay}`);
    }
  }
  return attacked;
}

/** Return the attack squares for one piece, including inherited movement powers. */
export function getPieceAttackSquares(state, x, y) {
  return getAttackSquares(state, x, y).map(([ax, ay]) => ({ x: ax, y: ay }));
}

export function isSquareAttacked(state, x, y, byColor) {
  for (let py = 0; py < 8; py++) {
    for (let px = 0; px < 8; px++) {
      const piece = state.board[py][px];
      if (piece?.color !== byColor) continue;
      if (getAttackSquares(state, px, py).some(([ax, ay]) => ax === x && ay === y)) return true;
    }
  }
  return false;
}

export function isInCheck(state, color) {
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const piece = state.board[y][x];
      if (piece?.color === color && piece.type === 'king') {
        return isSquareAttacked(state, x, y, color === 'white' ? 'black' : 'white');
      }
    }
  }
  return true;
}

function castleMoves(state, x, y, piece) {
  if (piece.type !== 'king' || piece.hasMoved || x !== 4 || y !== (piece.color === 'white' ? 7 : 0)) return [];
  if (isInCheck(state, piece.color)) return [];
  const row = y;
  const enemy = piece.color === 'white' ? 'black' : 'white';
  const moves = [];

  const kingSideRook = state.board[row][7];
  if (kingSideRook?.type === 'rook' && kingSideRook.color === piece.color && !kingSideRook.hasMoved &&
      !state.board[row][5] && !state.board[row][6] &&
      !isSquareAttacked(state, 5, row, enemy) && !isSquareAttacked(state, 6, row, enemy)) {
    moves.push({ x: 6, y: row, castle: 'king' });
  }

  const queenSideRook = state.board[row][0];
  if (queenSideRook?.type === 'rook' && queenSideRook.color === piece.color && !queenSideRook.hasMoved &&
      !state.board[row][1] && !state.board[row][2] && !state.board[row][3] &&
      !isSquareAttacked(state, 3, row, enemy) && !isSquareAttacked(state, 2, row, enemy)) {
    moves.push({ x: 2, y: row, castle: 'queen' });
  }
  return moves;
}

function applyUnchecked(state, fromX, fromY, move, promotion = 'queen', trackCaptureHistory = true) {
  const board = state.board;
  const piece = board[fromY][fromX];
  const toX = move.x;
  const toY = move.y;
  let captured = board[toY][toX];

  if (move.enPassant) {
    const capturedY = toY + (piece.color === 'white' ? 1 : -1);
    captured = board[capturedY][toX];
    board[capturedY][toX] = null;
  }

  let newlyInherited = [];
  if (captured) {
    // The king is immutable: capturing never changes its movement capabilities.
    if (piece.type !== 'king') {
      // A captured pawn contributes only powers it previously inherited, never pawn movement.
      // Capabilities are a set: duplicate captures do not create duplicate badges or abilities.
      const transferred = captured.type === 'pawn'
        ? uniquePowers(captured.powers)
        : uniquePowers([captured.type, ...(captured.powers || [])]);
      const alreadyOwned = new Set([piece.type, ...uniquePowers(piece.powers, piece.type)]);
      newlyInherited = transferred.filter((type) => !alreadyOwned.has(type));
      piece.powers = uniquePowers([...(piece.powers || []), ...newlyInherited], piece.type);
    } else {
      piece.powers = [];
    }

    if (trackCaptureHistory) {
      // Keep the capture tree on the surviving piece. If the captured unit had its own
      // capture history, that entire branch travels with it into the new tree.
      const capturedNode = {
        id: captured.id,
        color: captured.color,
        type: captured.type,
        powers: uniquePowers(captured.powers, captured.type),
        captures: clone(captured.captures || [])
      };
      piece.captures = [...(piece.captures || []), capturedNode];
      state.captured[piece.color].push(clone(capturedNode));
    }
  }

  board[fromY][fromX] = null;
  board[toY][toX] = piece;
  piece.hasMoved = true;

  if (move.castle) {
    const rookFromX = move.castle === 'king' ? 7 : 0;
    const rookToX = move.castle === 'king' ? 5 : 3;
    const rook = board[toY][rookFromX];
    board[toY][rookFromX] = null;
    board[toY][rookToX] = rook;
    rook.hasMoved = true;
  }

  if (piece.type === 'pawn' && (toY === 0 || toY === 7)) {
    piece.type = ['queen', 'rook', 'bishop', 'knight'].includes(promotion) ? promotion : 'queen';
    piece.promoted = true;
    // Promotion changes the native identity, so it no longer needs a duplicate copy
    // of that same movement capability in its inherited set.
    piece.powers = uniquePowers(piece.powers, piece.type);
  }

  state.enPassant = move.doublePawn ? { x: fromX, y: (fromY + toY) / 2 } : null;
  const previousTurn = state.turn;
  state.turn = previousTurn === 'white' ? 'black' : 'white';
  if (previousTurn === 'black') state.moveNumber += 1;

  return { piece, captured, inherited: newlyInherited };
}

export function getLegalMoves(state, x, y) {
  const piece = state.board[y]?.[x];
  if (!piece || piece.color !== state.turn || state.gameOver) return [];
  const pseudo = [...getPseudoMoves(state, x, y), ...castleMoves(state, x, y, piece)];
  return pseudo.filter((move) => {
    const test = clone(state);
    applyUnchecked(test, x, y, move, 'queen', false);
    return !isInCheck(test, piece.color);
  });
}

export function allLegalMoves(state, color = state.turn) {
  const originalTurn = state.turn;
  const proxy = color === originalTurn ? state : { ...state, turn: color };
  const result = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const piece = proxy.board[y][x];
      if (piece?.color === color) {
        for (const move of getLegalMoves(proxy, x, y)) result.push({ from: { x, y }, to: move });
      }
    }
  }
  return result;
}

export function getGameStatus(state) {
  const inCheck = isInCheck(state, state.turn);
  const moves = allLegalMoves(state, state.turn);
  // Checkmate/stalemate take precedence over automatic draw counters.
  if (moves.length === 0) {
    if (inCheck) return { status: 'checkmate', winner: state.turn === 'white' ? 'black' : 'white', check: state.turn, gameOver: true };
    return { status: 'stalemate', winner: null, check: null, gameOver: true, drawReason: 'stalemate' };
  }
  const repetitions = state.positionCounts?.[getPositionKey(state)] || 0;
  if (repetitions >= 3) {
    return { status: 'threefold-repetition', winner: null, check: inCheck ? state.turn : null, gameOver: true, drawReason: 'threefold-repetition' };
  }
  if ((state.halfmoveClock || 0) >= 100) {
    return { status: 'fifty-move-rule', winner: null, check: inCheck ? state.turn : null, gameOver: true, drawReason: 'fifty-move-rule' };
  }
  return { status: inCheck ? 'check' : 'active', winner: null, check: inCheck ? state.turn : null, gameOver: false, drawReason: null };
}

/**
 * Apply a move already produced by allLegalMoves() to a search-only state.
 * It deliberately skips UI history/capture-tree bookkeeping and game-status
 * recomputation so search can explore many positions efficiently.
 * Do not call this with an arbitrary, unvalidated move from the UI.
 */
export function applyGeneratedMove(state, generatedMove, promotion = 'queen') {
  if (!state || !generatedMove?.from || !generatedMove?.to) {
    throw new Error('A generated move with from/to coordinates is required.');
  }
  const { from, to } = generatedMove;
  if (!inBounds(from.x, from.y) || !inBounds(to.x, to.y)) {
    throw new Error('The generated move is outside the board.');
  }
  const piece = state.board[from.y]?.[from.x];
  if (!piece || piece.color !== state.turn) {
    throw new Error('The generated move does not match the side to move.');
  }

  applyUnchecked(state, from.x, from.y, to, promotion, false);
  // Search determines terminal positions by generating legal moves at each node.
  state.status = 'active';
  state.winner = null;
  state.check = null;
  state.gameOver = false;
  state.lastMove = { from: { ...from }, to: { x: to.x, y: to.y } };
  return state;
}

export function playMove(state, from, to, promotion = 'queen') {
  if (state.gameOver) throw new Error('This game has ended. Start a new match to play again.');
  if (!from || !to || !inBounds(from.x, from.y) || !inBounds(to.x, to.y)) throw new Error('That move is outside the board.');
  const piece = state.board[from.y][from.x];
  if (!piece) throw new Error('There is no piece on that square.');
  if (piece.color !== state.turn) throw new Error(`It is ${state.turn}’s turn.`);
  const move = getLegalMoves(state, from.x, from.y).find((candidate) => candidate.x === to.x && candidate.y === to.y);
  if (!move) throw new Error('That move is not legal.');

  const movingType = piece.type;
  if (!state.positionCounts) state.positionCounts = { [getPositionKey(state)]: 1 };
  else if (!state.positionCounts[getPositionKey(state)]) state.positionCounts[getPositionKey(state)] = 1;
  const notation = `${piece.color === 'white' ? 'White' : 'Black'} ${PIECE_NAMES[movingType]} ${squareName(from.x, from.y)} → ${squareName(to.x, to.y)}`;
  const result = applyUnchecked(state, from.x, from.y, move, promotion);
  state.halfmoveClock = movingType === 'pawn' || result.captured ? 0 : (state.halfmoveClock || 0) + 1;
  const resultingPositionKey = getPositionKey(state);
  state.positionCounts[resultingPositionKey] = (state.positionCounts[resultingPositionKey] || 0) + 1;
  const promotedTo = movingType === 'pawn' && result.piece.type !== 'pawn' ? result.piece.type : null;
  const record = {
    number: state.history.length + 1,
    color: piece.color,
    pieceId: piece.id,
    pieceType: movingType,
    from: squareName(from.x, from.y),
    to: squareName(to.x, to.y),
    notation: promotedTo ? `${notation} = ${PIECE_NAMES[promotedTo]}` : notation,
    capturedType: result.captured?.type || null,
    inherited: result.inherited,
    castle: move.castle || null,
    enPassant: Boolean(move.enPassant),
    promotion: promotedTo,
    playedAt: Date.now()
  };
  state.history.push(record);
  state.lastMove = { from, to };
  Object.assign(state, getGameStatus(state));
  return { record, state };
}

export function getPowerCounts(piece) {
  return Object.fromEntries(uniquePowers(piece?.powers, piece?.type).map((power) => [power, 1]));
}

export function squareToCoords(square) {
  if (typeof square !== 'string' || !/^[a-h][1-8]$/.test(square)) return null;
  return { x: FILES.indexOf(square[0]), y: 8 - Number(square[1]) };
}
