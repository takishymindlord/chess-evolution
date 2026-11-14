#!/usr/bin/env node
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInitialState, playMove, getGameStatus, allLegalMoves, applyGeneratedMove, getPositionKey } from '../public/engine.js';
import { AI_PERSONALITIES, evaluatePosition, extractPositionFeatures, findBestMove } from '../public/ai.js';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PERSONALITY_NAMES = Object.keys(AI_PERSONALITIES);
const LEAGUE_PAIRINGS = [
  ['balanced', 'evolutionist'],
  ['guardian', 'tactician'],
  ['balanced', 'guardian'],
  ['evolutionist', 'tactician'],
  ['balanced', 'tactician'],
  ['evolutionist', 'guardian']
];

function nowStamp() {
  return new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
}

function parseInteger(value, name, { min, max }) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

export function parseArgs(argv) {
  const options = {
    games: 100,
    mode: 'league',
    personality: 'balanced',
    depth: 1,
    timeMs: 80,
    maxNodes: 2_500,
    maxPlies: 120,
    openingRandomPlies: 4,
    openingWindowCp: 8,
    seed: Date.now() >>> 0,
    out: path.join('data', 'self-play', `run-${nowStamp()}`),
    watch: false,
    quiet: false
  };

  const valueOptions = new Map([
    ['--games', 'games'], ['--mode', 'mode'], ['--personality', 'personality'],
    ['--depth', 'depth'], ['--time-ms', 'timeMs'], ['--max-nodes', 'maxNodes'],
    ['--max-plies', 'maxPlies'], ['--opening-random-plies', 'openingRandomPlies'],
    ['--opening-window-cp', 'openingWindowCp'], ['--seed', 'seed'], ['--out', 'out']
  ]);

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help' || token === '-h') {
      options.help = true;
      continue;
    }
    if (token === '--watch') {
      options.watch = true;
      continue;
    }
    if (token === '--quiet') {
      options.quiet = true;
      continue;
    }
    const key = valueOptions.get(token);
    if (!key) throw new Error(`Unknown option: ${token}. Use --help to see available options.`);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`Option ${token} requires a value.`);
    options[key] = value;
    i += 1;
  }

  options.games = parseInteger(String(options.games), '--games', { min: 1, max: 100_000 });
  options.depth = parseInteger(String(options.depth), '--depth', { min: 1, max: 8 });
  options.timeMs = parseInteger(String(options.timeMs), '--time-ms', { min: 50, max: 60_000 });
  options.maxNodes = parseInteger(String(options.maxNodes), '--max-nodes', { min: 100, max: 5_000_000 });
  options.maxPlies = parseInteger(String(options.maxPlies), '--max-plies', { min: 20, max: 500 });
  options.openingRandomPlies = parseInteger(String(options.openingRandomPlies), '--opening-random-plies', { min: 0, max: 20 });
  options.openingWindowCp = parseInteger(String(options.openingWindowCp), '--opening-window-cp', { min: 0, max: 200 });
  options.seed = parseInteger(String(options.seed), '--seed', { min: 0, max: 4_294_967_295 });
  if (!['league', 'self'].includes(options.mode)) throw new Error('--mode must be league or self.');
  if (!PERSONALITY_NAMES.includes(options.personality)) {
    throw new Error(`--personality must be one of: ${PERSONALITY_NAMES.join(', ')}.`);
  }
  options.out = path.resolve(options.out);
  return options;
}

function coordName({ x, y }) {
  return `${'abcdefgh'[x]}${8 - y}`;
}

/** Position identity for repetition detection. Includes powers, side to move,
 * en-passant and moved flags (important for pawn double-steps/castling rights). */
export function positionKey(state) { return getPositionKey(state); }

function positionSnapshot(state) {
  return {
    turn: state.turn,
    enPassant: state.enPassant ? { ...state.enPassant } : null,
    board: state.board.map((row) => row.map((piece) => piece ? ({
      color: piece.color,
      type: piece.type,
      powers: [...new Set(piece.powers || [])].filter((power) => power !== piece.type && power !== 'pawn').sort(),
      hasMoved: Boolean(piece.hasMoved),
      promoted: Boolean(piece.promoted)
    }) : null))
  };
}

function stateFromSnapshot(snapshot) {
  return {
    board: snapshot.board,
    turn: snapshot.turn,
    enPassant: snapshot.enPassant
  };
}

function resultCode(winner) {
  return winner === 'white' ? '1-0' : winner === 'black' ? '0-1' : '1/2-1/2';
}

function sideOutcome(whiteOutcome, side) {
  return side === 'white' ? whiteOutcome : -whiteOutcome;
}


function seededRandom(seed = 1) {
  let value = (Number(seed) >>> 0) || 0x9e3779b9;
  return () => {
    value = (value + 0x6D2B79F5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function chooseOpeningExplorationMove(state, profile, seed, windowCp, evaluationModel = null) {
  const legal = allLegalMoves(state, state.turn);
  if (!legal.length) return null;
  const scored = legal.map((move) => {
    const child = structuredClone(state);
    applyGeneratedMove(child, move);
    const whiteScore = evaluatePosition(child, profile, evaluationModel);
    return { move, score: state.turn === 'white' ? whiteScore : -whiteScore };
  });
  const best = Math.max(...scored.map((entry) => entry.score));
  const shortlist = scored.filter((entry) => entry.score >= best - windowCp);
  const random = seededRandom(seed);
  const chosen = shortlist[Math.floor(random() * shortlist.length)];
  return { ...chosen, candidates: shortlist.length, totalLegalMoves: legal.length };
}

function countPieceStats(records) {
  const stats = {
    captures: { white: 0, black: 0 },
    inheritedAbilities: { white: 0, black: 0 },
    promotions: { white: 0, black: 0 }
  };
  for (const record of records) {
    if (record.capturedType) stats.captures[record.color] += 1;
    stats.inheritedAbilities[record.color] += (record.inherited || []).length;
    if (record.promotion) stats.promotions[record.color] += 1;
  }
  return stats;
}

export function selectPairing(gameIndex, mode = 'league', personality = 'balanced') {
  if (mode === 'self') {
    // Alternate seat assignment metadata even though both sides use one style.
    return { white: personality, black: personality };
  }
  const pairIndex = Math.floor(gameIndex / 2) % LEAGUE_PAIRINGS.length;
  const [first, second] = LEAGUE_PAIRINGS[pairIndex];
  return gameIndex % 2 === 0
    ? { white: first, black: second }
    : { white: second, black: first };
}

/** Runs one complete AI-vs-AI game and returns its record plus labeled positions. */
export function playSelfPlayGame({
  gameNumber = 1,
  whiteProfile = 'balanced',
  blackProfile = 'evolutionist',
  depth = 1,
  timeMs = 80,
  maxNodes = 2_500,
  maxPlies = 120,
  openingRandomPlies = 4,
  openingWindowCp = 8,
  seed = 1,
  watch = false,
  onMove = null,
  evaluationModel = null
} = {}) {
  if (!AI_PERSONALITIES[whiteProfile] || !AI_PERSONALITIES[blackProfile]) {
    throw new Error('Unknown AI personality supplied to self-play game.');
  }

  const state = createInitialState();
  const moves = [];
  const positions = [];
  let termination = null;
  let totalNodes = 0;
  let totalSearchMs = 0;
  let totalCompletedDepth = 0;

  for (let ply = 0; ply < maxPlies; ply += 1) {
    if (state.gameOver) {
      termination = state.status;
      break;
    }

    const side = state.turn;
    const profile = side === 'white' ? whiteProfile : blackProfile;
    const before = positionSnapshot(state);
    const tieBreakSeed = (Number(seed) + Math.imul(gameNumber, 1_000_003) + Math.imul(ply + 1, 97_409)) >>> 0;
    const startedAt = Date.now();
    const openingChoice = ply < openingRandomPlies
      ? chooseOpeningExplorationMove(state, profile, tieBreakSeed, openingWindowCp, evaluationModel)
      : null;
    const search = openingChoice
      ? {
          move: openingChoice.move,
          score: openingChoice.score,
          depth: 0,
          nodes: openingChoice.totalLegalMoves,
          qNodes: 0,
          ttHits: 0,
          elapsedMs: Date.now() - startedAt,
          selectionMethod: 'opening-exploration',
          openingCandidates: openingChoice.candidates
        }
      : {
          ...findBestMove(state, {
            depth,
            timeLimitMs: timeMs,
            maxNodes,
            personality: profile,
            randomizeTies: true,
            tieBreakSeed,
            model: evaluationModel
          }),
          selectionMethod: 'search',
          openingCandidates: 0
        };

    if (!search.move) {
      const status = getGameStatus(state);
      termination = status.status;
      state.status = status.status;
      state.winner = status.winner;
      state.gameOver = true;
      break;
    }

    const { record } = playMove(state, search.move.from, search.move.to);
    totalNodes += search.nodes;
    totalSearchMs += search.elapsedMs;
    totalCompletedDepth += search.depth;

    const enrichedMove = {
      ...record,
      profile,
      search: {
        scoreForMover: search.score,
        completedDepth: search.depth,
        nodes: search.nodes,
        quiescenceNodes: search.qNodes,
        transpositionHits: search.ttHits,
        elapsedMs: search.elapsedMs,
        selectionMethod: search.selectionMethod,
        openingCandidates: search.openingCandidates
      }
    };
    moves.push(enrichedMove);
    positions.push({
      gameNumber,
      ply,
      position: before,
      features: extractPositionFeatures(stateFromSnapshot(before), profile),
      sideToMove: side,
      profile,
      move: enrichedMove,
      searchScoreForSideToMove: search.score,
      searchScoreWhitePerspective: search.score == null ? null : (side === 'white' ? search.score : -search.score),
      terminal: false
    });

    if (watch) {
      const line = `#${String(ply + 1).padStart(3, '0')} ${side.toUpperCase().padEnd(5)} ${profile.padEnd(12)} ${record.notation}${record.inherited?.length ? ` [inherited: ${record.inherited.join(', ')}]` : ''}`;
      if (onMove) onMove(line, enrichedMove, state);
      else process.stdout.write(`${line}\n`);
    }

    if (state.gameOver) {
      termination = state.status;
      break;
    }
  }

  if (!termination) termination = 'move-limit';
  const winner = termination === 'checkmate' ? state.winner : null;
  const whiteOutcome = winner === 'white' ? 1 : winner === 'black' ? -1 : 0;
  const pieceStats = countPieceStats(moves);
  const finalPosition = positionSnapshot(state);
  positions.push({
    gameNumber,
    ply: moves.length,
    position: finalPosition,
    sideToMove: state.turn,
    profile: null,
    move: null,
    searchScoreForSideToMove: null,
    searchScoreWhitePerspective: null,
    terminal: true,
    outcomeWhitePerspective: whiteOutcome,
    outcomeSideToMovePerspective: sideOutcome(whiteOutcome, state.turn),
    termination
  });

  // Attach the final game outcome to every earlier position as labeled
  // experience for the separate self-play model trainer.
  for (const sample of positions) {
    if (!sample.terminal) {
      sample.outcomeWhitePerspective = whiteOutcome;
      sample.outcomeSideToMovePerspective = sideOutcome(whiteOutcome, sample.sideToMove);
      sample.termination = termination;
    }
  }

  return {
    game: {
      gameNumber,
      whiteProfile,
      blackProfile,
      result: resultCode(winner),
      winner,
      termination,
      plies: moves.length,
      moves,
      stats: pieceStats,
      search: {
        nodes: totalNodes,
        elapsedMs: totalSearchMs,
        averageCompletedDepth: moves.length ? totalCompletedDepth / moves.length : 0
      }
    },
    positions
  };
}

function makeLeaderboard() {
  return Object.fromEntries(PERSONALITY_NAMES.map((name) => [name, {
    label: AI_PERSONALITIES[name].label,
    games: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    selfMatches: 0,
    points: 0
  }]));
}

function updateSeatResult(stats, profile, outcome) {
  const row = stats[profile];
  row.games += 1;
  if (outcome > 0) { row.wins += 1; row.points += 1; }
  else if (outcome < 0) row.losses += 1;
  else { row.draws += 1; row.points += 0.5; }
}

function printHelp() {
  process.stdout.write(`\nChess Evolution Self-Play Training Lab\n\n` +
    `Usage:\n  npm run selfplay -- [options]\n\n` +
    `Options:\n` +
    `  --games N        Number of games (default: 100)\n` +
    `  --mode league     Four personalities rotate through a round-robin league (default)\n` +
    `  --mode self       One personality plays against itself\n` +
    `  --personality ID  balanced | evolutionist | guardian | tactician (default: balanced)\n` +
    `  --depth N         Search depth 1-8 (default: 1)\n` +
    `  --time-ms N       Per-move time budget, minimum 50 (default: 80)\n` +
    `  --max-nodes N     Per-move node budget (default: 2500)\n` +
    `  --max-plies N     Draw adjudication safety limit (default: 120)\n` +
    `  --opening-random-plies N  Explore near-equal moves in first N plies (default: 4)\n` +
    `  --opening-window-cp N     Opening evaluation window (default: 8)\n` +
    `  --seed N          Seed for reproducible randomized tie-breaks\n` +
    `  --out PATH        Output folder (default: data/self-play/run-TIMESTAMP)\n` +
    `  --watch           Print every move from the first game\n` +
    `  --quiet           Suppress progress lines\n` +
    `  --help            Show this help\n\n` +
    `Files written: games.jsonl, positions.jsonl, summary.json, manifest.json\n\n`);
}

export async function runTournament(options) {
  await mkdir(options.out, { recursive: true });
  const gamesPath = path.join(options.out, 'games.jsonl');
  const positionsPath = path.join(options.out, 'positions.jsonl');
  const gamesFile = await open(gamesPath, 'w');
  const positionsFile = await open(positionsPath, 'w');
  const leaderboard = makeLeaderboard();
  const terminationCounts = {};
  const pairingStats = {};
  const aggregate = { plies: 0, captures: 0, inheritedAbilities: 0, promotions: 0, searchNodes: 0, searchMs: 0 };
  const started = Date.now();
  const progressEvery = Math.max(1, Math.floor(options.games / 20));

  try {
    for (let index = 0; index < options.games; index += 1) {
      const pairing = selectPairing(index, options.mode, options.personality);
      const played = playSelfPlayGame({
        gameNumber: index + 1,
        whiteProfile: pairing.white,
        blackProfile: pairing.black,
        depth: options.depth,
        timeMs: options.timeMs,
        maxNodes: options.maxNodes,
        maxPlies: options.maxPlies,
        openingRandomPlies: options.openingRandomPlies,
        openingWindowCp: options.openingWindowCp,
        seed: options.seed,
        watch: options.watch && index === 0
      });
      const { game, positions } = played;
      const outcome = game.winner === 'white' ? 1 : game.winner === 'black' ? -1 : 0;
      if (game.whiteProfile === game.blackProfile) {
        // A personality playing itself is one self-play sample, not two
        // independent league entries or a personality win against itself.
        leaderboard[game.whiteProfile].games += 1;
        leaderboard[game.whiteProfile].selfMatches += 1;
        leaderboard[game.whiteProfile].points += 0.5;
      } else {
        updateSeatResult(leaderboard, game.whiteProfile, outcome);
        updateSeatResult(leaderboard, game.blackProfile, -outcome);
      }
      terminationCounts[game.termination] = (terminationCounts[game.termination] || 0) + 1;
      const pairKey = [game.whiteProfile, game.blackProfile].sort().join(' vs ');
      pairingStats[pairKey] ||= { games: 0, whiteWins: 0, blackWins: 0, draws: 0 };
      pairingStats[pairKey].games += 1;
      if (outcome > 0) pairingStats[pairKey].whiteWins += 1;
      else if (outcome < 0) pairingStats[pairKey].blackWins += 1;
      else pairingStats[pairKey].draws += 1;

      aggregate.plies += game.plies;
      aggregate.captures += game.stats.captures.white + game.stats.captures.black;
      aggregate.inheritedAbilities += game.stats.inheritedAbilities.white + game.stats.inheritedAbilities.black;
      aggregate.promotions += game.stats.promotions.white + game.stats.promotions.black;
      aggregate.searchNodes += game.search.nodes;
      aggregate.searchMs += game.search.elapsedMs;

      await gamesFile.writeFile(`${JSON.stringify(game)}\n`, 'utf8');
      for (const sample of positions) await positionsFile.writeFile(`${JSON.stringify(sample)}\n`, 'utf8');

      if (!options.quiet && ((index + 1) % progressEvery === 0 || index + 1 === options.games)) {
        const elapsed = (Date.now() - started) / 1000;
        process.stdout.write(`Completed ${index + 1}/${options.games} games | ${game.result} | ${game.termination} | ${elapsed.toFixed(1)}s elapsed\n`);
      }
    }
  } finally {
    await Promise.all([gamesFile.close(), positionsFile.close()]);
  }

  const durationMs = Date.now() - started;
  const summary = {
    createdAt: new Date().toISOString(),
    games: options.games,
    mode: options.mode,
    personality: options.mode === 'self' ? options.personality : null,
    search: { depth: options.depth, timeMs: options.timeMs, maxNodes: options.maxNodes },
    maxPlies: options.maxPlies,
    seed: options.seed,
    durationMs,
    durationSeconds: Number((durationMs / 1000).toFixed(2)),
    terminations: terminationCounts,
    leaderboard: Object.values(leaderboard).sort((a, b) => b.points - a.points || b.wins - a.wins),
    leaderboardById: leaderboard,
    pairings: pairingStats,
    aggregate: {
      ...aggregate,
      averagePliesPerGame: Number((aggregate.plies / options.games).toFixed(2)),
      averageNodesPerGame: Math.round(aggregate.searchNodes / options.games),
      averageSearchMsPerGame: Math.round(aggregate.searchMs / options.games)
    },
    dataFiles: ['games.jsonl', 'positions.jsonl'],
    trainingNote: 'Self-play experience dataset with terminal outcome labels and feature vectors. The Training Lab can fit and persist learned evaluation weights from these samples; this is a compact linear evaluator, not a deep neural network.'
  };

  const manifest = {
    application: 'Chess Evolution Self-Play Training Lab',
    projectVersion: '1.9.0',
    createdAt: summary.createdAt,
    parameters: options,
    personalities: AI_PERSONALITIES,
    dataSchema: {
      games: 'One JSON object per completed game, including full move records and aggregate search statistics.',
      positions: 'One JSON object per position, including board state, side to move, selected move, search data and final outcome labels.'
    },
    limitations: [
      'The learned evaluator is a compact supervised linear model over nine engine features, not a deep neural network.',
      'Named personalities remain fixed strategy profiles; the saved evaluation model is updated from game outcomes.',
      'The shared game engine applies threefold repetition and the 100-halfmove automatic draw rule in browser, online and self-play games.'
    ]
  };

  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(options.out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(path.join(options.out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return summary;
}

async function main(argv) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      printHelp();
      return;
    }
    process.stdout.write(`\nChess Evolution Self-Play Training Lab\n`);
    process.stdout.write(`Mode: ${options.mode} | Games: ${options.games} | Depth: ${options.depth} | Profiles: ${options.mode === 'self' ? options.personality : PERSONALITY_NAMES.join(', ')}\n`);
    process.stdout.write(`Output: ${options.out}\n\n`);
    const summary = await runTournament(options);
    process.stdout.write(`\nTraining run completed.\n`);
    process.stdout.write(`Games: ${summary.games} | Duration: ${summary.durationSeconds}s | Positions saved: see positions.jsonl\n`);
    process.stdout.write(`Average plies/game: ${summary.aggregate.averagePliesPerGame} | Average search nodes/game: ${summary.aggregate.averageNodesPerGame}\n`);
    process.stdout.write(`Results saved to: ${options.out}\n`);
    process.stdout.write(`Note: this is a self-play dataset, not a trained neural network.\n\n`);
  } catch (error) {
    process.stderr.write(`Self-play error: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === pathToFileURL(SCRIPT_PATH).href) {
  await main(process.argv.slice(2));
}
