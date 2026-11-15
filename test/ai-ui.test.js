import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const server = await readFile(new URL('../server.js', import.meta.url), 'utf8');
const worker = await readFile(new URL('../public/ai-worker.js', import.meta.url), 'utf8');
const serviceWorker = await readFile(new URL('../public/service-worker.js', import.meta.url), 'utf8');

test('lobby exposes side and difficulty selection for computer mode', () => {
  assert.match(html, /id="computerPlayBtn"/);
  assert.match(html, /id="computerSideSelect"/);
  assert.match(html, /id="computerDifficultySelect"/);
  for (const level of ['beginner', 'easy', 'medium', 'hard', 'expert']) {
    assert.match(html, new RegExp(`value="${level}"`));
  }
});

test('computer mode uses a worker and commits its response through the chess engine', () => {
  assert.match(app, /new Worker\('\/ai-worker\.js', \{ type: 'module'/);
  assert.match(app, /playMove\(gameState, move\.from, move\.to, 'queen'\)/);
  assert.match(app, /gameMode === 'computer'/);
  assert.match(worker, /findBestMove\(state, \{ \.\.\.AI_DEFAULTS\[difficulty\], model: model \|\| null \}\)/);
});

test('AI vs AI watch mode is exposed and uses the background search worker', () => {
  assert.match(html, /id="aiWatchBtn"/);
  assert.match(html, /id="aiWatchWhiteSelect"/);
  assert.match(html, /id="aiWatchBlackSelect"/);
  assert.match(html, /id="aiWatchSpeedSelect"/);
  assert.match(app, /gameMode = 'aiwatch'/);
  assert.match(app, /requestAiWatchMove\(\)/);
  assert.match(app, /gameMode === 'aiwatch'/);
  assert.match(app, /setTimeout\(\(\) => \{ aiWatchTimer = null; requestAiWatchMove\(\); \}, aiWatchDelayMs\)/);
});

test('PWA app shell precaches the AI engine and its worker', () => {
  assert.match(serviceWorker, /chess-evolution-static-v12/);
  assert.match(serviceWorker, /'\/ai\.js'/);
  assert.match(serviceWorker, /'\/ai-worker\.js'/);
});

test('Training Lab exposes parallel self-play settings, progress and stop controls', () => {
  for (const id of ['trainingGamesSelect', 'trainingWorkersSelect', 'trainingDepthSelect', 'startTrainingBtn', 'stopTrainingBtn', 'trainingProgressFill', 'trainingPositions', 'trainingWeights']) {
    assert.match(html, new RegExp(`id=\"${id}\"`));
  }
  assert.match(app, /api\/training\/start/);
  assert.match(app, /api\/training\/status/);
  assert.match(app, /api\/training\/model/);
});

test('live Training Lab exposes a key field and authenticates start/stop requests', () => {
  assert.match(html, /id="trainingApiKeyInput"/);
  assert.match(html, /id="saveTrainingKeyBtn"/);
  assert.match(app, /sessionStorage\.setItem\(TRAINING_KEY_SESSION, key\)/);
  assert.match(app, /'x-training-key': key/);
  assert.match(server, /TRAINING_API_KEY/);
  assert.match(server, /timingSafeEqual/);
  assert.match(server, /status\(401\)/);
  assert.match(server, /requireTrainingAccess\(req, res\)/);
});
