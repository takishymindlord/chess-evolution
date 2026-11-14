import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_EVALUATION_MODEL, EVALUATION_FEATURES, extractPositionFeatures, evaluatePosition } from '../public/ai.js';
import { createInitialState } from '../public/engine.js';
import { trainEvaluationModel } from '../scripts/model-training.js';

test('the engine exports a fixed-size feature vector used by evaluation', () => {
  const state = createInitialState();
  const features = extractPositionFeatures(state);
  assert.deepEqual(Object.keys(features).sort(), [...EVALUATION_FEATURES].sort());
  assert.equal(evaluatePosition(state), EVALUATION_FEATURES.reduce((score, name) => score + features[name], 0));
});

test('batch training changes and returns persistent evaluation weights', () => {
  const samples = [];
  for (let gameNumber = 1; gameNumber <= 20; gameNumber += 1) {
    const outcome = gameNumber % 2 === 0 ? 1 : -1;
    for (let position = 0; position < 4; position += 1) {
      const features = Object.fromEntries(EVALUATION_FEATURES.map((name) => [name, 0]));
      features.inheritance = outcome * (150 + position * 30);
      features.material = outcome * (80 + position * 10);
      samples.push({ gameNumber, features, outcomeWhitePerspective: outcome });
    }
  }
  const result = trainEvaluationModel(samples, DEFAULT_EVALUATION_MODEL, { epochs: 8, batchSize: 16, learningRate: 0.01, seed: 7 });
  assert.equal(result.model.generation, 1);
  assert.equal(result.metrics.samples, samples.length);
  assert.ok(result.model.weights.inheritance > 1);
  assert.notDeepEqual(result.model.weights, DEFAULT_EVALUATION_MODEL.weights);
  assert.ok(result.metrics.validationLoss <= result.metrics.baselineValidationLoss, 'best checkpoint should not regress held-out loss');
});
