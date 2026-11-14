import test from 'node:test';
import assert from 'node:assert/strict';
import { allLegalMoves, createInitialState } from '../public/engine.js';

test('AI worker responds with a legal move for a browser-style search request', async () => {
  let messageHandler = null;
  let response = null;
  const previousSelf = globalThis.self;

  globalThis.self = {
    addEventListener(type, handler) {
      if (type === 'message') messageHandler = handler;
    },
    postMessage(message) {
      response = message;
    }
  };

  try {
    await import(`../public/ai-worker.js?test=${Date.now()}`);
    assert.equal(typeof messageHandler, 'function', 'worker should register a message handler');
    messageHandler({
      data: {
        type: 'search',
        requestId: 42,
        difficulty: 'easy',
        state: createInitialState()
      }
    });

    assert.equal(response.requestId, 42);
    assert.ok(response.result?.move, 'worker should return a move');
    assert.ok(allLegalMoves(createInitialState()).some((move) =>
      move.from.x === response.result.move.from.x &&
      move.from.y === response.result.move.from.y &&
      move.to.x === response.result.move.to.x &&
      move.to.y === response.result.move.to.y
    ), 'worker result should be a legal opening move');
  } finally {
    if (previousSelf === undefined) delete globalThis.self;
    else globalThis.self = previousSelf;
  }
});
