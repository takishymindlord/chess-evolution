import { AI_DEFAULTS, findBestMove } from './ai.js';

self.addEventListener('message', (event) => {
  const message = event.data || {};
  if (message.type !== 'search') return;

  const { requestId, state, model } = message;
  const difficulty = Object.hasOwn(AI_DEFAULTS, message.difficulty) ? message.difficulty : 'medium';

  try {
    const result = findBestMove(state, { ...AI_DEFAULTS[difficulty], model: model || null });
    self.postMessage({ requestId, result });
  } catch (error) {
    self.postMessage({
      requestId,
      error: error instanceof Error ? error.message : 'Unknown AI search error'
    });
  }
});
