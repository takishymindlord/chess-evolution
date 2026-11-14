# Chess Evolution AI — Step 2: Playable computer opponent

This milestone connects the first search engine to the existing game interface.

## What's included

- A **Play Against Computer** lobby panel.
- Side selection: play as White or Black.
- Five initial search presets: Beginner, Easy, Medium, Hard, Expert.
- A module Web Worker (`public/ai-worker.js`) runs the search off the main UI thread.
- The worker receives a compact board snapshot, not the capture-history tree.
- AI moves are committed through the same `playMove()` validator and recorder used for human moves.
- The existing engine's legal move generator and capture inheritance rules are used throughout search.
- Starting a new mode or leaving the match terminates any unfinished search worker.
- The service worker cache is bumped to v6 and precaches `ai.js` and `ai-worker.js` for PWA usage.

## Run it

Requires Node.js 22 or newer.

```powershell
npm install
npm test
npm start
```

Open `http://localhost:3000`, enter a name, select **Play Against Computer**, choose your side and difficulty, then click **Challenge the AI**.

## What this AI is — and isn't

This is the first playable, rule-aware search opponent. It uses iterative-deepening negamax, alpha-beta pruning, move ordering, and a handcrafted evaluation that considers material and unique inherited powers. It searches actual Chess Evolution legal moves and simulates captures through the engine's search move applier.

It is **not yet a trained neural-network model**, and its five difficulty labels are initial resource presets, not calibrated human rating levels. The next development stage should improve tactical evaluation, add search refinements, and play self-play matches to measure strength before attempting NNUE training.

## Tests

`npm test` covers the existing Chess Evolution rules, the search engine, AI move validity for both sides, the browser-worker request/response, search-time inheritance, lobby controls, and PWA cache references.
