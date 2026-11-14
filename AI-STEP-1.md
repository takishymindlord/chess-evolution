# Chess Evolution AI — Step 1 (Search Core)

This milestone adds a first search-only computer opponent. It is intentionally **not connected to the game menu yet**. First we verify that it chooses legal moves and understands inherited capabilities; the next milestone can connect it to a `Play Against Computer` mode and run it in a Web Worker.

## What's included

- `public/ai.js`: iterative-deepening negamax search with alpha-beta pruning.
- `test/ai.test.js`: tests for legal move selection, capture preference, and duplicate capability evaluation.
- `public/engine.js`: `applyGeneratedMove()` applies moves already produced by `allLegalMoves()` efficiently for search. It applies capture inheritance but skips UI capture-tree/history bookkeeping and terminal-state recomputation.

The evaluator currently uses material, inherited-power bonuses, pawn advancement and center development. This is a first baseline, not a grandmaster-strength engine. It does not yet include quiescence search, repetition/50-move draw handling, opening books, or trained NNUE evaluation.

## Install / update

1. Back up your existing project folder.
2. Copy the contents of this project over your existing `chess-evolution` folder, or copy these specific files:
   - Replace `public/engine.js`.
   - Add `public/ai.js`.
   - Add `test/ai.test.js`.
3. In PowerShell, open the folder containing `package.json`.
4. Run:

```powershell
npm test
```

Expected result: 22 tests pass.

## Try the AI from Node.js

From the project folder, run:

```powershell
node --input-type=module
```

Then paste:

```js
const { createInitialState } = await import('./public/engine.js');
const { findBestMove, AI_DEFAULTS } = await import('./public/ai.js');

const state = createInitialState();
const result = findBestMove(state, AI_DEFAULTS.easy);

console.log('AI suggestion:', result.move);
console.log('Search depth:', result.depth);
console.log('Nodes searched:', result.nodes);
console.log('Time (ms):', result.elapsedMs);
```

The returned move has this shape:

```js
{
  from: { x: 4, y: 6 },
  to: { x: 4, y: 4, doublePawn: true }
}
```

Coordinates are zero-based (`a1` is `{x:0,y:7}`). To apply a returned move to a real game state, call the normal validated UI/game method:

```js
playMove(state, result.move.from, result.move.to);
```

Do **not** use `applyGeneratedMove()` for a human/UI move. It is only for moves returned by `allLegalMoves()` inside search.

## Important performance note

`findBestMove()` is synchronous in this milestone, so do not call it directly from a live UI click handler. The next integration milestone should run the search in a Web Worker so the board remains responsive, especially on phones.


## Step 2: UI integration

The search module is now connected to a dedicated browser module worker (`public/ai-worker.js`). The lobby exposes `Play Against Computer`, side selection, and five initial difficulty presets. The human move path still validates and records moves through `playMove`; AI moves are validated through the same function before being committed. The worker receives a compact board snapshot without capture genealogy, and is terminated when a match is abandoned or restarted.
