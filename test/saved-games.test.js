import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const engine = await readFile(new URL('../public/engine.js', import.meta.url), 'utf8');
const server = await readFile(new URL('../server.js', import.meta.url), 'utf8');
const storage = await readFile(new URL('../public/game-storage.js', import.meta.url), 'utf8');
const serviceWorker = await readFile(new URL('../public/service-worker.js', import.meta.url), 'utf8');
const trainingManager = await readFile(new URL('../scripts/training-manager.js', import.meta.url), 'utf8');

test('completed matches expose an optional save action and a Saved Games view', () => {
  assert.match(html, /id="saveMatchBtn"/);
  assert.match(html, /id="savedGamesNavBtn"/);
  assert.match(html, /id="savedGamesScreen"/);
  assert.match(app, /async function saveCurrentMatch\(/);
  assert.match(app, /function openSavedGames\(/);
});

test('all move records retain timestamps needed for faithful replay', () => {
  assert.match(engine, /startedAt: Date\.now\(\)/);
  assert.match(engine, /playedAt: Date\.now\(\)/);
  assert.match(app, /scaledMoveDelay\(/);
  assert.match(html, /Original timing/);
  for (const speed of ['0.5', '1', '2', '4']) assert.match(html, new RegExp(`value="${speed}"`));
});

test('saved games use IndexedDB locally and sync through owner-keyed server endpoints', () => {
  assert.match(storage, /indexedDB\.open/);
  assert.match(storage, /chessEvolution\.archiveKey/);
  assert.match(server, /app\.get\('\/api\/saved-games'/);
  assert.match(server, /app\.post\('\/api\/saved-games\/sync'/);
  assert.match(server, /app\.delete\('\/api\/saved-games\/:gameId'/);
  assert.match(server, /SAVED_GAMES_DIR/);
  assert.match(app, /offset \+= 8/);
  assert.match(app, /pending\.slice\(offset, offset \+ 8\)/);
});

test('PWA offline shell precaches saved-game modules and advances the cache version', () => {
  assert.match(serviceWorker, /chess-evolution-static-v12/);
  assert.match(serviceWorker, /'\/game-storage\.js'/);
  assert.match(serviceWorker, /'\/game-replay\.js'/);
});

test('personal game archives stay out of Git while trained model weights can be versioned', async () => {
  const gitignore = await readFile(new URL('../.gitignore', import.meta.url), 'utf8');
  assert.match(gitignore, /data\/saved-games\//);
  assert.match(gitignore, /data\/training\/\*/);
  assert.match(gitignore, /!data\/training\/current-model\.json/);
  assert.match(trainingManager, /current-model\.json/);
});
