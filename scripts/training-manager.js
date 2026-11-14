import { Worker } from 'node:worker_threads';
import os from 'node:os';
import path from 'node:path';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { DEFAULT_EVALUATION_MODEL } from '../public/ai.js';
import { trainEvaluationModel } from './model-training.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_ROOT = path.join(ROOT, 'data', 'training');
const WORKER_URL = new URL('./training-worker.js', import.meta.url);

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

async function readJson(filePath, fallback = null) {
  try { return JSON.parse(await readFile(filePath, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

export class TrainingManager {
  constructor() {
    this.model = structuredClone(DEFAULT_EVALUATION_MODEL);
    this.status = {
      running: false,
      phase: 'idle',
      generation: 0,
      games: 0,
      gamesCompleted: 0,
      workers: 0,
      positionsCollected: 0,
      captures: 0,
      inheritedAbilities: 0,
      whiteWins: 0,
      blackWins: 0,
      draws: 0,
      startedAt: null,
      finishedAt: null,
      error: null,
      metrics: null,
      weights: { ...DEFAULT_EVALUATION_MODEL.weights }
    };
    this.cancelBuffer = null;
    this.runPromise = null;
    this.ready = this.loadModel();
  }

  async loadModel() {
    await mkdir(DATA_ROOT, { recursive: true });
    const saved = await readJson(path.join(DATA_ROOT, 'current-model.json'), null);
    if (saved && saved.schemaVersion === 1 && saved.weights) this.model = saved;
    this.status.generation = Number(this.model.generation) || 0;
    this.status.weights = { ...this.model.weights };
    return this.model;
  }

  getModel() {
    return structuredClone(this.model);
  }

  getStatus() {
    const status = structuredClone(this.status);
    status.progress = status.games > 0 ? Math.round((status.gamesCompleted / status.games) * 100) : 0;
    status.modelGeneration = Number(this.model.generation) || 0;
    status.hardwareThreads = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
    return status;
  }

  async start(rawOptions = {}) {
    await this.ready;
    if (this.status.running) throw new Error('A training generation is already running.');

    const hardwareThreads = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
    const games = boundedInteger(rawOptions.games, 200, 1, 10_000);
    const workers = Math.min(games, boundedInteger(rawOptions.workers, Math.min(4, hardwareThreads), 1, 16), Math.max(1, hardwareThreads));
    const options = {
      games,
      workers,
      depth: boundedInteger(rawOptions.depth, 2, 1, 5),
      timeMs: boundedInteger(rawOptions.timeMs, 120, 50, 3_000),
      maxNodes: boundedInteger(rawOptions.maxNodes, 8_000, 100, 100_000),
      maxPlies: boundedInteger(rawOptions.maxPlies, 120, 20, 200),
      openingRandomPlies: boundedInteger(rawOptions.openingRandomPlies, 4, 0, 12),
      openingWindowCp: boundedInteger(rawOptions.openingWindowCp, 20, 0, 200),
      seed: boundedInteger(rawOptions.seed, Date.now() >>> 0, 0, 4_294_967_295)
    };
    const generation = (Number(this.model.generation) || 0) + 1;
    const generationName = `generation-${String(generation).padStart(3, '0')}`;
    const outputDirectory = path.join(DATA_ROOT, generationName);
    await mkdir(outputDirectory, { recursive: true });

    this.cancelBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    this.status = {
      running: true,
      phase: 'self-play',
      generation,
      games,
      gamesCompleted: 0,
      workers,
      positionsCollected: 0,
      captures: 0,
      inheritedAbilities: 0,
      whiteWins: 0,
      blackWins: 0,
      draws: 0,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
      metrics: null,
      outputDirectory: path.relative(ROOT, outputDirectory).replaceAll(path.sep, '/'),
      weights: { ...this.model.weights }
    };

    const workerAssignments = Array.from({ length: workers }, () => []);
    for (let index = 0; index < games; index += 1) workerAssignments[index % workers].push(index + 1);

    this.runPromise = this.runGeneration({
      options,
      generation,
      outputDirectory,
      workerAssignments,
      previousModel: this.getModel()
    });
    return this.getStatus();
  }

  stop() {
    if (!this.status.running || !this.cancelBuffer) return this.getStatus();
    Atomics.store(new Int32Array(this.cancelBuffer), 0, 1);
    this.status.phase = 'stopping';
    return this.getStatus();
  }

  async runWorker(workerIndex, gameNumbers, context) {
    if (!gameNumbers.length) return;
    const { outputDirectory, options, previousModel } = context;
    await new Promise((resolve, reject) => {
      const worker = new Worker(WORKER_URL, {
        workerData: {
          workerIndex,
          gameNumbers,
          outputDirectory,
          options,
          evaluationModel: previousModel,
          cancelBuffer: this.cancelBuffer
        }
      });
      let finishedMessage = false;
      let workerError = null;
      worker.on('message', (message) => {
        if (message.type === 'worker-complete') finishedMessage = true;
        if (message.type !== 'game-complete') return;
        this.status.gamesCompleted += 1;
        // Counts in each progress event are cumulative within that worker.
        this.status.whiteWins += message.whiteWins - (this._workerTotals?.[workerIndex]?.whiteWins || 0);
        this.status.blackWins += message.blackWins - (this._workerTotals?.[workerIndex]?.blackWins || 0);
        this.status.draws += message.draws - (this._workerTotals?.[workerIndex]?.draws || 0);
        this.status.positionsCollected += message.positionsCollected - (this._workerTotals?.[workerIndex]?.positionsCollected || 0);
        this.status.captures += message.captures - (this._workerTotals?.[workerIndex]?.captures || 0);
        this.status.inheritedAbilities += message.inheritedAbilities - (this._workerTotals?.[workerIndex]?.inheritedAbilities || 0);
        this._workerTotals ||= {};
        this._workerTotals[workerIndex] = {
          positionsCollected: message.positionsCollected,
          captures: message.captures,
          inheritedAbilities: message.inheritedAbilities,
          whiteWins: message.whiteWins,
          blackWins: message.blackWins,
          draws: message.draws
        };
      });
      worker.on('error', (error) => {
        workerError = error;
        if (this.cancelBuffer) Atomics.store(new Int32Array(this.cancelBuffer), 0, 1);
      });
      worker.on('exit', (code) => {
        if (workerError) reject(workerError);
        else if (code !== 0) reject(new Error(`Training worker ${workerIndex + 1} exited with code ${code}.`));
        else resolve(finishedMessage);
      });
    });
  }

  async mergeWorkerFiles(directory, workers) {
    const gamesPath = path.join(directory, 'games.jsonl');
    const positionsPath = path.join(directory, 'positions.jsonl');
    await writeFile(gamesPath, '', 'utf8');
    await writeFile(positionsPath, '', 'utf8');
    for (let workerIndex = 0; workerIndex < workers; workerIndex += 1) {
      for (const [prefix, destination] of [['games', gamesPath], ['positions', positionsPath]]) {
        const source = path.join(directory, `${prefix}-worker-${workerIndex}.jsonl`);
        try {
          const content = await readFile(source, 'utf8');
          if (content) await appendFile(destination, content, 'utf8');
          await rm(source, { force: true });
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
    }
    return { gamesPath, positionsPath };
  }

  async readTrainingSamples(positionsPath) {
    const samples = [];
    const input = createReadStream(positionsPath, { encoding: 'utf8' });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line) continue;
      const value = JSON.parse(line);
      if (!value.terminal && value.features && Number.isFinite(Number(value.outcomeWhitePerspective))) {
        samples.push({
          gameNumber: value.gameNumber,
          features: value.features,
          outcomeWhitePerspective: value.outcomeWhitePerspective
        });
      }
    }
    return samples;
  }

  async runGeneration(context) {
    const { options, generation, outputDirectory, workerAssignments, previousModel } = context;
    this._workerTotals = {};
    let workerError = null;
    try {
      const workerResults = await Promise.allSettled(workerAssignments.map((games, index) => this.runWorker(index, games, context)));
      const failedWorker = workerResults.find((result) => result.status === 'rejected');
      if (failedWorker) throw failedWorker.reason;
      const { gamesPath, positionsPath } = await this.mergeWorkerFiles(outputDirectory, options.workers);
      this.status.phase = 'training';
      const samples = await this.readTrainingSamples(positionsPath);
      if (samples.length < 8) {
        const cancelled = Atomics.load(new Int32Array(this.cancelBuffer), 0) !== 0;
        if (cancelled) throw new Error('Training was stopped before enough self-play positions were collected. No new model was saved.');
        throw new Error(`Only ${samples.length} labeled positions were collected; at least 8 are needed to train.`);
      }

      const trained = trainEvaluationModel(samples, previousModel, { seed: options.seed });
      this.model = trained.model;
      this.status.weights = { ...this.model.weights };
      this.status.metrics = trained.metrics;

      const generationSummary = {
        application: 'Chess Evolution Training Lab',
        generation,
        createdAt: this.model.updatedAt,
        completedAt: new Date().toISOString(),
        cancelled: Atomics.load(new Int32Array(this.cancelBuffer), 0) !== 0,
        options,
        gamesCompleted: this.status.gamesCompleted,
        positionsCollected: this.status.positionsCollected,
        labeledPositions: samples.length,
        results: {
          whiteWins: this.status.whiteWins,
          blackWins: this.status.blackWins,
          draws: this.status.draws,
          captures: this.status.captures,
          inheritedAbilities: this.status.inheritedAbilities
        },
        metrics: trained.metrics,
        model: this.model,
        dataFiles: ['games.jsonl', 'positions.jsonl'],
        explanation: 'Self-play positions were labeled with final game outcomes. Mini-batch logistic regression fitted nine feature weights and retained the best held-out validation checkpoint; the saved model is used by subsequent AI searches.'
      };
      await Promise.all([
        writeFile(path.join(outputDirectory, 'model.json'), `${JSON.stringify(this.model, null, 2)}\n`),
        writeFile(path.join(outputDirectory, 'summary.json'), `${JSON.stringify(generationSummary, null, 2)}\n`),
        writeFile(path.join(DATA_ROOT, 'current-model.json'), `${JSON.stringify(this.model, null, 2)}\n`),
        writeFile(path.join(DATA_ROOT, 'latest-summary.json'), `${JSON.stringify(generationSummary, null, 2)}\n`)
      ]);
      this.status.running = false;
      this.status.phase = 'complete';
      this.status.finishedAt = new Date().toISOString();
      this.status.error = null;
      this.status.outputDirectory = path.relative(ROOT, outputDirectory).replaceAll(path.sep, '/');
      this.status.progress = 100;
      this.status.validationImproved = trained.metrics.validationImproved;
      this.status.modelGeneration = this.model.generation;
      return generationSummary;
    } catch (error) {
      workerError = error;
      this.status.running = false;
      this.status.phase = 'error';
      this.status.finishedAt = new Date().toISOString();
      this.status.error = error instanceof Error ? error.message : String(error);
      try {
        await this.mergeWorkerFiles(outputDirectory, options.workers);
      } catch {}
      return null;
    } finally {
      this._workerTotals = null;
      this.cancelBuffer = null;
      this.runPromise = null;
      if (workerError) this.status.error = workerError.message || String(workerError);
    }
  }
}

export const trainingManager = new TrainingManager();
