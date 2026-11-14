import {
  allLegalMoves,
  applyGeneratedMove,
  isInCheck,
  getAttackedSquares,
  getPieceAttackSquares
} from './engine.js';

const PIECE_VALUE = Object.freeze({
  pawn: 100,
  knight: 320,
  bishop: 335,
  rook: 500,
  queen: 900,
  king: 20000
});

// Marginal value of adding a distinct movement capability to a piece.
// These are evaluation weights, not rules: the chess engine remains the
// authority on which moves are legal.
const POWER_VALUE = Object.freeze({
  pawn: 0,
  knight: 105,
  bishop: 78,
  rook: 92,
  queen: 145,
  king: 0
});

const SPECIAL_POWERS = Object.freeze(['queen', 'rook', 'bishop', 'knight']);

// Self-play personalities share the same legal move generator and search code,
// but emphasize different strategic priorities in their position evaluation.
export const AI_PERSONALITIES = Object.freeze({
  balanced: Object.freeze({ label: 'Balanced', powerValue: 1, synergy: 1, exposure: 1, protection: 1, forks: 1, pawnAdvance: 1 }),
  evolutionist: Object.freeze({ label: 'Evolutionist', powerValue: 1.48, synergy: 1.35, exposure: 0.88, protection: 0.95, forks: 1.12, pawnAdvance: 1.05 }),
  guardian: Object.freeze({ label: 'Guardian', powerValue: 1.16, synergy: 1.12, exposure: 1.62, protection: 1.72, forks: 0.92, pawnAdvance: 0.95 }),
  tactician: Object.freeze({ label: 'Tactician', powerValue: 1.24, synergy: 1.38, exposure: 1.12, protection: 1.05, forks: 1.72, pawnAdvance: 1.08 })
});

function getPersonality(personality = 'balanced') {
  if (personality && typeof personality === 'object') return personality;
  return AI_PERSONALITIES[personality] || AI_PERSONALITIES.balanced;
}
const MATE_SCORE = 100000;
const MATE_THRESHOLD = MATE_SCORE - 1000;
const INF = 1_000_000;
const MAX_TT_ENTRIES = 60_000;
const MAX_QUIESCENCE_DEPTH = 8;
const ABSOLUTE_QUIESCENCE_DEPTH = 13;
const ABORT_SEARCH = Symbol('abort-search');


function createSeededRandom(seed = 1) {
  let value = (Number(seed) >>> 0) || 0x9e3779b9;
  return () => {
    value = (value + 0x6D2B79F5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function uniqueCapabilities(piece) {
  if (!piece || piece.type === 'king') return new Set(piece?.type === 'king' ? ['king'] : []);
  return new Set([piece.type, ...(piece.powers || [])].filter((power) => power !== 'pawn'));
}

function effectivePieceValue(piece, personality = AI_PERSONALITIES.balanced) {
  if (!piece) return 0;
  const capabilities = uniqueCapabilities(piece);
  let value = PIECE_VALUE[piece.type] ?? 0;
  for (const power of capabilities) {
    if (power !== piece.type) value += (POWER_VALUE[power] ?? 0) * personality.powerValue;
  }

  const specialCount = SPECIAL_POWERS.filter((power) => capabilities.has(power)).length;
  if (specialCount >= 2) value += 24 * (specialCount - 1) * personality.synergy;
  if (capabilities.has('knight') && (capabilities.has('rook') || capabilities.has('bishop') || capabilities.has('queen'))) {
    value += 32 * personality.synergy;
  }
  if (SPECIAL_POWERS.every((power) => capabilities.has(power))) value += 260 * personality.synergy;
  return value;
}

function cloneForSearch(state) {
  return {
    ...state,
    board: state.board.map((row) => row.map((piece) => piece ? {
      ...piece,
      powers: [...(piece.powers || [])],
      // Capture genealogy is presentation data; it does not affect move legality.
      captures: []
    } : null)),
    enPassant: state.enPassant ? { ...state.enPassant } : null,
    history: [],
    captured: { white: [], black: [] },
    lastMove: null,
    status: 'active',
    winner: null,
    check: null,
    gameOver: false
  };
}

function centerBonus(x, y) {
  const distance = Math.abs(3.5 - x) + Math.abs(3.5 - y);
  return Math.max(0, 7 - distance) * 2;
}

function kingPosition(state, color) {
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const piece = state.board[y][x];
      if (piece?.color === color && piece.type === 'king') return { x, y };
    }
  }
  return null;
}

/**
 * White-positive static evaluation of a Chess Evolution position.
 * In addition to material and inherited powers, it estimates exposed units,
 * defended units, capability synergies, pawn progress and king safety.
 */
export function evaluatePosition(state, personalityName = 'balanced') {
  const personality = getPersonality(personalityName);
  let score = 0;
  const occupied = [];

  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const piece = state.board[y][x];
      if (!piece) continue;
      occupied.push({ piece, x, y });

      const sign = piece.color === 'white' ? 1 : -1;
      let value = effectivePieceValue(piece, personality);
      const capabilities = uniqueCapabilities(piece);

      if (piece.type === 'pawn') {
        const advancement = piece.color === 'white' ? 6 - y : y - 1;
        const centralFileFactor = Math.max(0, 3.5 - Math.abs(3.5 - x));
        value += Math.max(0, advancement) * (5 + centralFileFactor * 2) * personality.pawnAdvance;
        if (advancement >= 4) value += 14 * personality.pawnAdvance;
      } else if (piece.type !== 'king') {
        value += centerBonus(x, y) * (capabilities.has('knight') ? 1.6 : 1);
      }

      // A combination is more valuable than the sum of isolated badges when
      // it creates useful movement geometry (for example, Knight + Rook).
      if (piece.type !== 'king' && capabilities.has('knight') && capabilities.has('bishop')) value += 18 * personality.synergy;
      if (piece.type !== 'king' && capabilities.has('rook') && capabilities.has('bishop')) value += 24 * personality.synergy;

      score += sign * value;
    }
  }

  // Build attack maps once per evaluation. This is much cheaper than asking
  // whether each individual square is attacked by rescanning the whole board.
  const whiteAttacks = getAttackedSquares(state, 'white');
  const blackAttacks = getAttackedSquares(state, 'black');

  // Tactical exposure: evolved pieces are valuable targets. Penalize attacked
  // pieces more heavily when no friendly unit appears to defend the square.
  for (const { piece, x, y } of occupied) {
    if (piece.type === 'king') continue;
    const square = `${x},${y}`;
    const enemyAttacks = piece.color === 'white' ? blackAttacks : whiteAttacks;
    const friendlyAttacks = piece.color === 'white' ? whiteAttacks : blackAttacks;
    const attacked = enemyAttacks.has(square);
    const defended = friendlyAttacks.has(square);
    const sign = piece.color === 'white' ? 1 : -1;

    if (attacked) {
      const risk = effectivePieceValue(piece, personality) * (defended ? 0.09 : 0.27) * personality.exposure;
      score -= sign * Math.min(230, risk);
    } else if (defended && uniqueCapabilities(piece).size > 1) {
      // A defended hybrid has a little extra strategic stability: friendly
      // coordination helps preserve movement powers accumulated by captures.
      const inheritedValue = Math.max(0, effectivePieceValue(piece, personality) - (PIECE_VALUE[piece.type] ?? 0));
      score += sign * Math.min(22, 4 + inheritedValue * 0.045) * personality.protection;
    }
  }

  // Reward genuine multi-target pressure. This is deliberately a modest bonus:
  // it recognizes forks and coordinated attacks without pretending that every
  // pseudo-attack is automatically a forced win.
  for (const { piece, x, y } of occupied) {
    if (piece.type === 'king') continue;
    const sign = piece.color === 'white' ? 1 : -1;
    const enemyAttacks = piece.color === 'white' ? blackAttacks : whiteAttacks;
    const targets = [];
    for (const square of getPieceAttackSquares(state, x, y)) {
      const target = state.board[square.y][square.x];
      if (!target || target.color === piece.color || target.type === 'king') continue;
      const targetKey = `${square.x},${square.y}`;
      const isDefended = enemyAttacks.has(targetKey);
      const targetValue = effectivePieceValue(target, personality);
      if (targetValue >= 260) targets.push(targetValue * (isDefended ? 0.22 : 0.48));
    }
    targets.sort((a, b) => b - a);
    if (targets.length >= 2) score += sign * Math.min(85, (targets[0] + targets[1]) * 0.055) * personality.forks;
  }

  // Being in check is a real positional liability. The same attack maps provide
  // king-safety information without a second full scan of the board.
  const whiteKing = kingPosition(state, 'white');
  const blackKing = kingPosition(state, 'black');
  if (whiteKing && blackAttacks.has(`${whiteKing.x},${whiteKing.y}`)) score -= 95;
  if (blackKing && whiteAttacks.has(`${blackKing.x},${blackKing.y}`)) score += 95;

  // Small king-shelter bonus for nearby friendly pawns. It is intentionally
  // modest so that material and forcing tactics dominate the evaluation.
  for (const color of ['white', 'black']) {
    const king = kingPosition(state, color);
    if (!king) continue;
    const direction = color === 'white' ? -1 : 1;
    let shield = 0;
    for (const dx of [-1, 0, 1]) {
      const x = king.x + dx;
      const y = king.y + direction;
      if (x < 0 || x > 7 || y < 0 || y > 7) continue;
      if (state.board[y][x]?.color === color && state.board[y][x]?.type === 'pawn') shield += 7;
    }
    score += (color === 'white' ? 1 : -1) * shield;
  }

  return score;
}

function evaluateForSideToMove(state, personality = 'balanced') {
  const whiteScore = evaluatePosition(state, personality);
  return state.turn === 'white' ? whiteScore : -whiteScore;
}

function capturedPieceForMove(state, move) {
  const { to } = move;
  if (to.enPassant) {
    const capturedY = to.y + (state.turn === 'white' ? 1 : -1);
    return state.board[capturedY]?.[to.x] || null;
  }
  return state.board[to.y]?.[to.x] || null;
}

function isPromotionMove(state, move) {
  const mover = state.board[move.from.y]?.[move.from.x];
  return mover?.type === 'pawn' && (move.to.y === 0 || move.to.y === 7);
}

function moveKey(move) {
  return `${move.from.x}${move.from.y}${move.to.x}${move.to.y}${move.to.castle || ''}${move.to.enPassant ? 'e' : ''}${move.to.doublePawn ? 'd' : ''}`;
}

function historyKey(color, move) {
  return `${color}:${moveKey(move)}`;
}

function newPowerGain(mover, captured) {
  if (!mover || !captured || mover.type === 'king') return [];
  const owned = new Set([mover.type, ...(mover.powers || [])]);
  const transferred = captured.type === 'pawn'
    ? (captured.powers || [])
    : [captured.type, ...(captured.powers || [])];
  return [...new Set(transferred)].filter((power) => power !== 'pawn' && !owned.has(power));
}

function orderMoves(state, moves, context, ply, preferredMoveKey = null) {
  const color = state.turn;
  return moves.map((move) => {
    const mover = state.board[move.from.y][move.from.x];
    const captured = capturedPieceForMove(state, move);
    const key = moveKey(move);
    let priority = 0;

    if (preferredMoveKey && key === preferredMoveKey) priority += 2_000_000;

    if (captured) {
      priority += 100_000 + effectivePieceValue(captured) * 100 - effectivePieceValue(mover) * 0.12;
      for (const power of newPowerGain(mover, captured)) priority += (POWER_VALUE[power] ?? 0) * 35;
    }

    if (isPromotionMove(state, move)) priority += 85_000;
    if (move.to.castle) priority += 600;

    if (!captured) {
      const killers = context.killers[ply] || [];
      if (killers[0] === key) priority += 50_000;
      else if (killers[1] === key) priority += 35_000;
      priority += context.history.get(historyKey(color, move)) || 0;
    }

    return { move, key, priority };
  }).sort((a, b) => b.priority - a.priority).map((item) => item.move);
}

function rememberQuietCutoff(context, state, move, depth, ply) {
  const key = moveKey(move);
  const killers = context.killers[ply] || (context.killers[ply] = []);
  if (killers[0] !== key) {
    killers[1] = killers[0];
    killers[0] = key;
  }
  const hKey = historyKey(state.turn, move);
  const bonus = depth * depth * 12;
  context.history.set(hKey, Math.min(1_000_000, (context.history.get(hKey) || 0) + bonus));
}

function stateKey(state) {
  const rows = [];
  for (let y = 0; y < 8; y++) {
    let row = '';
    for (let x = 0; x < 8; x++) {
      const piece = state.board[y][x];
      if (!piece) {
        row += '..,';
        continue;
      }
      const color = piece.color === 'white' ? 'w' : 'b';
      const powers = piece.type === 'king' ? '' : [...new Set(piece.powers || [])].sort().join('.');
      row += `${color}${piece.type}:${piece.hasMoved ? 1 : 0}[${powers}],`;
    }
    rows.push(row);
  }
  const ep = state.enPassant ? `${state.enPassant.x}${state.enPassant.y}` : '-';
  return `${state.turn}|${ep}|${rows.join('/')}`;
}

function scoreToTable(score, ply) {
  if (score > MATE_THRESHOLD) return score + ply;
  if (score < -MATE_THRESHOLD) return score - ply;
  return score;
}

function scoreFromTable(score, ply) {
  if (score > MATE_THRESHOLD) return score - ply;
  if (score < -MATE_THRESHOLD) return score + ply;
  return score;
}

function storeTableEntry(context, key, entry) {
  if (!context.tt.has(key) && context.tt.size >= MAX_TT_ENTRIES) {
    const oldestKey = context.tt.keys().next().value;
    if (oldestKey !== undefined) context.tt.delete(oldestKey);
  }
  context.tt.set(key, entry);
}

function checkAbort(context, isQuiescence = false) {
  context.nodes += 1;
  if (isQuiescence) context.qNodes += 1;
  if (context.nodes > context.maxNodes) throw ABORT_SEARCH;
  if ((context.nodes & 127) === 0 && Date.now() >= context.deadline) throw ABORT_SEARCH;
}

function quiescence(state, alpha, beta, ply, qDepth, context, knownMoves = null, knownInCheck = null) {
  checkAbort(context, true);
  const inCheck = knownInCheck ?? isInCheck(state, state.turn);
  const moves = knownMoves || allLegalMoves(state, state.turn);

  if (moves.length === 0) return inCheck ? -MATE_SCORE + ply : 0;
  if (qDepth >= ABSOLUTE_QUIESCENCE_DEPTH) {
    return evaluateForSideToMove(state, context.personality) - (inCheck ? 180 : 0);
  }

  let bestScore = -INF;
  if (!inCheck) {
    const standPat = evaluateForSideToMove(state, context.personality);
    bestScore = standPat;
    if (standPat >= beta) return standPat;
    if (standPat > alpha) alpha = standPat;
    if (qDepth >= MAX_QUIESCENCE_DEPTH) return standPat;
  }

  // When in check, every legal evasion must be considered. Otherwise extend
  // only captures and promotions to resolve forcing exchanges at the horizon.
  const tacticalMoves = inCheck
    ? moves
    : moves.filter((move) => Boolean(capturedPieceForMove(state, move)) || isPromotionMove(state, move));

  if (tacticalMoves.length === 0) return bestScore === -INF ? evaluateForSideToMove(state, context.personality) : bestScore;

  for (const move of orderMoves(state, tacticalMoves, context, ply)) {
    const child = cloneForSearch(state);
    applyGeneratedMove(child, move);
    const score = -quiescence(child, -beta, -alpha, ply + 1, qDepth + 1, context);
    if (score > bestScore) bestScore = score;
    if (score > alpha) alpha = score;
    if (alpha >= beta) break;
  }

  return bestScore;
}

function negamax(state, depth, alpha, beta, ply, context) {
  checkAbort(context);
  const alphaOriginal = alpha;
  const betaOriginal = beta;
  const key = stateKey(state);
  const ttEntry = context.tt.get(key);
  let preferredMoveKey = ttEntry?.bestMoveKey || null;

  if (ttEntry && ttEntry.depth >= depth) {
    context.ttHits += 1;
    const ttScore = scoreFromTable(ttEntry.score, ply);
    if (ttEntry.bound === 'exact') return ttScore;
    if (ttEntry.bound === 'lower') alpha = Math.max(alpha, ttScore);
    else if (ttEntry.bound === 'upper') beta = Math.min(beta, ttScore);
    if (alpha >= beta) return ttScore;
  }

  const inCheck = isInCheck(state, state.turn);
  const moves = allLegalMoves(state, state.turn);
  if (moves.length === 0) return inCheck ? -MATE_SCORE + ply : 0;
  if (depth <= 0) return quiescence(state, alpha, beta, ply, 0, context, moves, inCheck);

  let bestScore = -INF;
  let bestMoveKey = null;
  const ordered = orderMoves(state, moves, context, ply, preferredMoveKey);

  for (const move of ordered) {
    const child = cloneForSearch(state);
    applyGeneratedMove(child, move);
    const score = -negamax(child, depth - 1, -beta, -alpha, ply + 1, context);

    if (score > bestScore) {
      bestScore = score;
      bestMoveKey = moveKey(move);
    }
    if (score > alpha) alpha = score;
    if (alpha >= beta) {
      if (!capturedPieceForMove(state, move) && !isPromotionMove(state, move)) {
        rememberQuietCutoff(context, state, move, depth, ply);
      }
      break;
    }
  }

  const bound = bestScore <= alphaOriginal ? 'upper' : bestScore >= betaOriginal ? 'lower' : 'exact';
  storeTableEntry(context, key, {
    depth,
    score: scoreToTable(bestScore, ply),
    bound,
    bestMoveKey
  });
  return bestScore;
}

function searchRoot(state, moves, depth, context) {
  let alpha = -INF;
  const beta = INF;
  let bestMove = null;
  let bestScore = -INF;
  let bestMoveTieCount = 0;
  const rootKey = stateKey(state);
  const previousBest = context.tt.get(rootKey)?.bestMoveKey || null;

  for (const move of orderMoves(state, moves, context, 0, previousBest)) {
    checkAbort(context);
    const child = cloneForSearch(state);
    applyGeneratedMove(child, move);
    const score = -negamax(child, depth - 1, -beta, -alpha, 1, context);

    if (score > bestScore) {
      bestScore = score;
      bestMove = move;
      bestMoveTieCount = 1;
    } else if (context.randomizeTies && score === bestScore) {
      // Reservoir-sample exact root-score ties so self-play explores more than
      // one deterministic opening/move order. Normal player-vs-AI stays stable.
      bestMoveTieCount += 1;
      if (context.random() < (1 / bestMoveTieCount)) bestMove = move;
    }
    if (score > alpha) alpha = score;
  }

  storeTableEntry(context, rootKey, {
    depth,
    score: scoreToTable(bestScore, 0),
    bound: 'exact',
    bestMoveKey: bestMove ? moveKey(bestMove) : null
  });
  return { move: bestMove, score: bestScore };
}

/**
 * Find a move using iterative-deepening negamax, alpha-beta pruning,
 * quiescence search, a transposition table and tactical move-ordering heuristics.
 *
 * @param {object} state Current Chess Evolution state (not mutated).
 * @param {object} options Search limits: depth, timeLimitMs, maxNodes.
 * @returns {{move: object|null, score: number|null, depth: number, nodes: number, qNodes: number, ttHits: number, elapsedMs: number}}
 */
export function findBestMove(state, options = {}) {
  const maxDepth = Math.max(1, Math.min(8, Number(options.depth) || 2));
  const timeLimitMs = Math.max(50, Number(options.timeLimitMs) || 1500);
  const maxNodes = Math.max(100, Number(options.maxNodes) || 100_000);
  const startedAt = Date.now();

  const rootState = cloneForSearch(state);
  const rootMoves = allLegalMoves(rootState, rootState.turn);
  if (rootMoves.length === 0) {
    return { move: null, score: null, depth: 0, nodes: 0, qNodes: 0, ttHits: 0, elapsedMs: Date.now() - startedAt };
  }

  const context = {
    nodes: 0,
    qNodes: 0,
    ttHits: 0,
    maxNodes,
    deadline: startedAt + timeLimitMs,
    tt: new Map(),
    killers: [],
    history: new Map(),
    personality: getPersonality(options.personality),
    randomizeTies: Boolean(options.randomizeTies),
    random: createSeededRandom(options.tieBreakSeed ?? 1)
  };

  // Keep a legal fallback in case a very small time budget interrupts depth 1.
  let completed = { move: orderMoves(rootState, rootMoves, context, 0)[0], score: null, depth: 0 };

  for (let depth = 1; depth <= maxDepth; depth++) {
    try {
      const result = searchRoot(rootState, rootMoves, depth, context);
      completed = { ...result, depth };
    } catch (error) {
      if (error !== ABORT_SEARCH) throw error;
      break;
    }

    if (Math.abs(completed.score) >= MATE_SCORE - 10) break;
    if (Date.now() >= context.deadline || context.nodes >= maxNodes) break;
  }

  return {
    personality: options.personality || 'balanced',
    move: completed.move,
    score: completed.score,
    depth: completed.depth,
    nodes: context.nodes,
    qNodes: context.qNodes,
    ttHits: context.ttHits,
    elapsedMs: Date.now() - startedAt
  };
}

export const AI_DEFAULTS = Object.freeze({
  beginner: { depth: 1, timeLimitMs: 180, maxNodes: 3_000 },
  easy: { depth: 2, timeLimitMs: 450, maxNodes: 12_000 },
  medium: { depth: 3, timeLimitMs: 1_100, maxNodes: 35_000 },
  hard: { depth: 4, timeLimitMs: 2_500, maxNodes: 90_000 },
  expert: { depth: 5, timeLimitMs: 5_000, maxNodes: 200_000 }
});
