#!/usr/bin/env node
import { trainingManager } from './training-manager.js';

function readOptions(argv) {
  const options = {};
  const names = new Map([
    ['--games', 'games'], ['--workers', 'workers'], ['--depth', 'depth'],
    ['--time-ms', 'timeMs'], ['--max-plies', 'maxPlies']
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const name = names.get(argv[index]);
    if (!name || !argv[index + 1] || argv[index + 1].startsWith('--')) {
      throw new Error(`Invalid training option: ${argv[index]}`);
    }
    options[name] = Number(argv[index + 1]);
    index += 1;
  }
  return options;
}

try {
  const options = readOptions(process.argv.slice(2));
  const started = await trainingManager.start(options);
  process.stdout.write(`Generation ${started.generation}: ${started.games} games across ${started.workers} workers\n`);
  await trainingManager.runPromise;
  const status = trainingManager.getStatus();
  if (status.phase !== 'complete') throw new Error(status.error || 'Training did not complete.');
  process.stdout.write(`Completed ${status.gamesCompleted} games; collected ${status.positionsCollected} positions.\n`);
  process.stdout.write(`Model weights saved: data/training/current-model.json\n`);
  process.stdout.write(`Validation loss: ${status.metrics.baselineValidationLoss} -> ${status.metrics.validationLoss}\n`);
} catch (error) {
  process.stderr.write(`Training failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
