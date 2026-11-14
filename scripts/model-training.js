import { DEFAULT_EVALUATION_MODEL, EVALUATION_FEATURES } from '../public/ai.js';

function sigmoid(value) {
  if (value > 30) return 1;
  if (value < -30) return 0;
  return 1 / (1 + Math.exp(-value));
}

function sampleTarget(sample) {
  const outcome = Number(sample.outcomeWhitePerspective);
  if (!Number.isFinite(outcome)) return null;
  return (Math.max(-1, Math.min(1, outcome)) + 1) / 2;
}

function sampleLogit(sample, weights) {
  let total = 0;
  for (const name of EVALUATION_FEATURES) {
    total += (Number(sample.features?.[name]) || 0) * (weights[name] ?? 1);
  }
  return total / 1_800;
}

function crossEntropy(samples, weights) {
  if (!samples.length) return null;
  const epsilon = 1e-7;
  let loss = 0;
  for (const sample of samples) {
    const target = sampleTarget(sample);
    if (target === null) continue;
    const prediction = Math.min(1 - epsilon, Math.max(epsilon, sigmoid(sampleLogit(sample, weights))));
    loss += -(target * Math.log(prediction) + (1 - target) * Math.log(1 - prediction));
  }
  return Number((loss / samples.length).toFixed(6));
}

function deterministicShuffle(items, seed = 1) {
  const result = [...items];
  let value = (Number(seed) >>> 0) || 0x9e3779b9;
  const random = () => {
    value = (value + 0x6D2B79F5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * Fit a compact linear evaluation model from labeled self-play positions.
 * The target is the final game result (white win=1, draw=.5, black win=0).
 * This is supervised weight learning, not a deep neural network.
 */
export function trainEvaluationModel(samples, previousModel = DEFAULT_EVALUATION_MODEL, options = {}) {
  const usable = (samples || []).filter((sample) => sample?.features && sampleTarget(sample) !== null);
  if (usable.length < 8) {
    throw new Error(`At least 8 labeled non-terminal positions are required; received ${usable.length}.`);
  }

  const gameNumbers = [...new Set(usable.map((sample) => Number(sample.gameNumber)).filter(Number.isFinite))];
  const validationGames = new Set(gameNumbers.filter((gameNumber) => gameNumber % 5 === 0));
  let training = usable.filter((sample) => !validationGames.has(Number(sample.gameNumber)));
  let validation = usable.filter((sample) => validationGames.has(Number(sample.gameNumber)));
  if (training.length < 4 || validation.length < 2) {
    training = usable.filter((_, index) => index % 5 !== 0);
    validation = usable.filter((_, index) => index % 5 === 0);
  }
  if (!validation.length) validation = training.slice(-Math.max(2, Math.floor(training.length / 5)));

  const weights = Object.fromEntries(EVALUATION_FEATURES.map((name) => {
    const value = Number(previousModel?.weights?.[name]);
    return [name, Number.isFinite(value) ? Math.max(0.2, Math.min(3, value)) : 1];
  }));
  const baselineValidationLoss = crossEntropy(validation, weights);
  let bestValidationLoss = baselineValidationLoss;
  let bestWeights = { ...weights };
  let bestEpoch = 0;
  const epochs = Math.max(1, Math.min(100, Number(options.epochs) || 24));
  const batchSize = Math.max(8, Math.min(2048, Number(options.batchSize) || 256));
  const learningRate = Math.max(0.0001, Math.min(0.1, Number(options.learningRate) || 0.008));
  const regularization = 0.002;
  let batches = 0;

  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const shuffled = deterministicShuffle(training, (options.seed || 1) + epoch * 7919);
    for (let start = 0; start < shuffled.length; start += batchSize) {
      const batch = shuffled.slice(start, start + batchSize);
      const gradients = Object.fromEntries(EVALUATION_FEATURES.map((name) => [name, 0]));
      for (const sample of batch) {
        const target = sampleTarget(sample);
        const prediction = sigmoid(sampleLogit(sample, weights));
        const error = prediction - target;
        for (const name of EVALUATION_FEATURES) {
          const feature = (Number(sample.features[name]) || 0) / 1_800;
          gradients[name] += error * feature;
        }
      }
      for (const name of EVALUATION_FEATURES) {
        const gradient = gradients[name] / batch.length + regularization * (weights[name] - 1);
        weights[name] = Math.max(0.2, Math.min(3, weights[name] - learningRate * gradient));
      }
      batches += 1;
    }
    // Keep the best held-out checkpoint. A noisy or overfit epoch must never
    // replace a model that performed better on unseen self-play games.
    const epochValidationLoss = crossEntropy(validation, weights);
    if (epochValidationLoss !== null && (bestValidationLoss === null || epochValidationLoss < bestValidationLoss)) {
      bestValidationLoss = epochValidationLoss;
      bestWeights = { ...weights };
      bestEpoch = epoch + 1;
    }
  }

  Object.assign(weights, bestWeights);
  const validationLoss = crossEntropy(validation, weights);
  const trainingLoss = crossEntropy(training, weights);
  const model = {
    schemaVersion: 1,
    generation: (Number(previousModel?.generation) || 0) + 1,
    trainedGames: (Number(previousModel?.trainedGames) || 0) + gameNumbers.length,
    trainedPositions: (Number(previousModel?.trainedPositions) || 0) + usable.length,
    updatedAt: new Date().toISOString(),
    algorithm: 'mini-batch logistic regression over engine evaluation features',
    weights: Object.fromEntries(EVALUATION_FEATURES.map((name) => [name, Number(weights[name].toFixed(5))]))
  };

  return {
    model,
    metrics: {
      samples: usable.length,
      trainingSamples: training.length,
      validationSamples: validation.length,
      games: gameNumbers.length,
      epochs,
      bestEpoch,
      batchSize,
      batches,
      learningRate,
      baselineValidationLoss,
      validationLoss,
      trainingLoss,
      validationImproved: validationLoss !== null && baselineValidationLoss !== null && validationLoss < baselineValidationLoss,
      weightChanges: Object.fromEntries(EVALUATION_FEATURES.map((name) => [name, Number((model.weights[name] - (Number(previousModel?.weights?.[name]) || 1)).toFixed(5))]))
    }
  };
}
