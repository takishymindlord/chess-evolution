import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
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
  assert.match(worker, /findBestMove\(state, AI_DEFAULTS\[difficulty\]\)/);
});

test('PWA app shell precaches the AI engine and its worker', () => {
  assert.match(serviceWorker, /chess-evolution-static-v7/);
  assert.match(serviceWorker, /'\/ai\.js'/);
  assert.match(serviceWorker, /'\/ai-worker\.js'/);
});
