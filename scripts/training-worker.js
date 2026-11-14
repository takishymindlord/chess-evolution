import { parentPort, workerData } from 'node:worker_threads';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { playSelfPlayGame } from './self-play.js';

const {
  workerIndex,
  gameNumbers,
  outputDirectory,
  options,
  evaluationModel,
  cancelBuffer
} = workerData;
const cancellation = new Int32Array(cancelBuffer);

await mkdir(outputDirectory, { recursive: true });
const gamesFile = await open(path.join(outputDirectory, `games-worker-${workerIndex}.jsonl`), 'w');
const positionsFile = await open(path.join(outputDirectory, `positions-worker-${workerIndex}.jsonl`), 'w');
let gamesCompleted = 0;
let positionsCollected = 0;
let captures = 0;
let inheritedAbilities = 0;
let whiteWins = 0;
let blackWins = 0;
let draws = 0;
let totalPlies = 0;

try {
  for (const gameNumber of gameNumbers) {
    if (Atomics.load(cancellation, 0) !== 0) break;
    // Both seats use identical baseline strategy settings and the same learned
    // model snapshot: these are genuine copies of the current agent playing
    // opposite colors, not a personality tournament.
    const pairing = { white: 'balanced', black: 'balanced' };
    const result = playSelfPlayGame({
      gameNumber,
      whiteProfile: pairing.white,
      blackProfile: pairing.black,
      depth: options.depth,
      timeMs: options.timeMs,
      maxNodes: options.maxNodes,
      maxPlies: options.maxPlies,
      openingRandomPlies: options.openingRandomPlies,
      openingWindowCp: options.openingWindowCp,
      seed: options.seed,
      evaluationModel
    });
    result.game.generation = evaluationModel.generation + 1;
    result.game.modelGenerationUsed = evaluationModel.generation;
    await gamesFile.writeFile(`${JSON.stringify(result.game)}\n`, 'utf8');
    for (const sample of result.positions) {
      sample.generation = evaluationModel.generation + 1;
      await positionsFile.writeFile(`${JSON.stringify(sample)}\n`, 'utf8');
      positionsCollected += 1;
    }

    gamesCompleted += 1;
    captures += result.game.stats.captures.white + result.game.stats.captures.black;
    inheritedAbilities += result.game.stats.inheritedAbilities.white + result.game.stats.inheritedAbilities.black;
    totalPlies += result.game.plies;
    if (result.game.winner === 'white') whiteWins += 1;
    else if (result.game.winner === 'black') blackWins += 1;
    else draws += 1;

    parentPort?.postMessage({
      type: 'game-complete',
      workerIndex,
      gameNumber,
      gamesCompleted,
      positionsCollected,
      captures,
      inheritedAbilities,
      whiteWins,
      blackWins,
      draws,
      totalPlies,
      termination: result.game.termination
    });
  }
} finally {
  await Promise.all([gamesFile.close(), positionsFile.close()]);
}

parentPort?.postMessage({
  type: 'worker-complete',
  workerIndex,
  gamesCompleted,
  positionsCollected,
  captures,
  inheritedAbilities,
  whiteWins,
  blackWins,
  draws,
  totalPlies,
  cancelled: Atomics.load(cancellation, 0) !== 0
});
