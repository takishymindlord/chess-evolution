import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInitialState } from '../public/engine.js';
import { AI_PERSONALITIES, evaluatePosition } from '../public/ai.js';
import { chooseOpeningExplorationMove, parseArgs, playSelfPlayGame, positionKey, runTournament } from '../scripts/self-play.js';

function emptyLikeInitial() {
  const state = createInitialState();
  state.board = Array.from({ length: 8 }, () => Array(8).fill(null));
  state.board[7][4] = { id: 'wk', color: 'white', type: 'king', powers: [], captures: [], hasMoved: true };
  state.board[0][4] = { id: 'bk', color: 'black', type: 'king', powers: [], captures: [], hasMoved: true };
  state.board[4][3] = { id: 'wr', color: 'white', type: 'rook', powers: ['knight'], captures: [], hasMoved: true };
  state.turn = 'white';
  state.enPassant = null;
  return state;
}


test('seeded opening exploration is reproducible and diversifies near-equal legal moves', () => {
  const state = createInitialState();
  const first = chooseOpeningExplorationMove(state, 'balanced', 12345, 8);
  const repeat = chooseOpeningExplorationMove(state, 'balanced', 12345, 8);
  assert.deepEqual(first.move, repeat.move, 'the same seed should reproduce the same opening choice');
  assert.ok(first.candidates > 1, 'the opening should have multiple near-equal candidates');
  const choices = new Set();
  for (let seed = 1; seed <= 12; seed += 1) {
    const choice = chooseOpeningExplorationMove(state, 'balanced', seed, 8);
    choices.add(`${choice.move.from.x},${choice.move.from.y}-${choice.move.to.x},${choice.move.to.y}`);
  }
  assert.ok(choices.size > 1, 'different seeds should produce different opening choices');
});

test('self-play personalities are defined and produce different evaluations', () => {
  assert.deepEqual(Object.keys(AI_PERSONALITIES).sort(), ['balanced', 'evolutionist', 'guardian', 'tactician']);
  const state = emptyLikeInitial();
  const balanced = evaluatePosition(state, 'balanced');
  const evolutionist = evaluatePosition(state, 'evolutionist');
  const guardian = evaluatePosition(state, 'guardian');
  assert.notEqual(evolutionist, balanced);
  assert.notEqual(guardian, balanced);
});

test('position identity includes inherited powers and side-to-move', () => {
  const state = emptyLikeInitial();
  const original = positionKey(state);
  state.board[4][3].powers = ['bishop', 'knight'];
  assert.notEqual(positionKey(state), original);
  const withPowers = positionKey(state);
  state.turn = 'black';
  assert.notEqual(positionKey(state), withPowers);
});

test('self-play produces legal moves and stops at its configured safety limit', () => {
  const result = playSelfPlayGame({
    gameNumber: 7,
    whiteProfile: 'evolutionist',
    blackProfile: 'guardian',
    depth: 1,
    timeMs: 50,
    maxNodes: 300,
    maxPlies: 20,
    openingRandomPlies: 0,
    seed: 777
  });
  assert.equal(result.game.gameNumber, 7);
  assert.equal(result.game.plies, 20);
  assert.equal(result.game.termination, 'move-limit');
  assert.equal(result.game.moves.length, 20);
  assert.equal(result.positions.length, 21, 'one sample per played position plus terminal position');
  assert.ok(result.game.moves.every((move) => move.search && move.profile));
  assert.ok(result.positions.at(-1).terminal);
  assert.equal(result.positions.at(-1).outcomeWhitePerspective, 0);
});

test('argument parser validates tournament settings', () => {
  const args = parseArgs(['--games', '10', '--mode', 'self', '--personality', 'tactician', '--depth', '2', '--max-plies', '80', '--seed', '12345', '--out', 'tmp/self-play-test']);
  assert.equal(args.games, 10);
  assert.equal(args.mode, 'self');
  assert.equal(args.personality, 'tactician');
  assert.equal(args.depth, 2);
  assert.throws(() => parseArgs(['--mode', 'neural']), /must be league or self/);
  assert.throws(() => parseArgs(['--games', '0']), /between 1 and 100000/);
});

test('tournament runner writes games, labeled positions and summary files', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'chess-evolution-selfplay-'));
  try {
    const summary = await runTournament({
      games: 1,
      mode: 'self',
      personality: 'balanced',
      depth: 1,
      timeMs: 50,
      maxNodes: 300,
      maxPlies: 20,
      openingRandomPlies: 0,
      seed: 777,
      out: tempDir,
      watch: false,
      quiet: true
    });
    const gamesText = await readFile(path.join(tempDir, 'games.jsonl'), 'utf8');
    const positionsText = await readFile(path.join(tempDir, 'positions.jsonl'), 'utf8');
    const summaryText = JSON.parse(await readFile(path.join(tempDir, 'summary.json'), 'utf8'));
    const manifest = JSON.parse(await readFile(path.join(tempDir, 'manifest.json'), 'utf8'));
    assert.equal(gamesText.trim().split('\n').length, 1);
    assert.equal(positionsText.trim().split('\n').length, 21);
    assert.equal(summary.games, 1);
    assert.equal(summaryText.games, 1);
    assert.equal(summaryText.leaderboardById.balanced.games, 1);
    assert.equal(summaryText.leaderboardById.balanced.selfMatches, 1);
    assert.match(manifest.application, /Self-Play Training Lab/);
    assert.match(summary.trainingNote, /does not train/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
