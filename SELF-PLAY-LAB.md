# Chess Evolution Self-Play Training Lab (v1.8.0)

This is a local Node.js command-line tool. It runs AI-vs-AI games using the same legal-move and inheritance engine as the browser game. It does not add an AI-vs-AI button to the public-facing game yet; it is intended for local development and dataset generation on your Windows PC.

## Requirements

- Node.js 22 or newer (below 27)
- The project dependencies installed with `npm install`
- No NVIDIA GPU is required for self-play data generation

## Quick start

Open PowerShell in the project folder and run:

```powershell
npm install
npm test
npm run selfplay -- --games 10 --depth 1 --time-ms 50 --max-nodes 1200 --max-plies 100 --seed 12345 --watch
```

This runs ten games between the four-profile league, printing the moves from the first game. Use the small pilot before scaling to 100 or 1,000 games.

## Run the 100-game pilot

```powershell
npm run selfplay -- --games 100 --depth 1 --time-ms 80 --max-nodes 2500 --max-plies 120 --seed 12345
```

## Modes

### Personality league (default)

```powershell
npm run selfplay -- --games 100 --mode league
```

The tool rotates the following four handcrafted evaluation profiles through a round-robin pairing schedule, swapping colors on the second meeting. The first four plies use seeded opening exploration: the runner selects reproducibly among legal moves within the configured evaluation window of the best static candidate. This diversifies training positions while retaining the official legal-move/inheritance engine. All later plies use the regular search engine.

- `balanced`: current default evaluation emphasis
- `evolutionist`: places extra value on acquiring and combining inherited movement powers
- `guardian`: prioritizes safety and support for evolved units
- `tactician`: emphasizes multi-target pressure and tactical combinations

These are four evaluation-weight profiles, not four independently trained neural networks.

### One personality against itself

```powershell
npm run selfplay -- --games 100 --mode self --personality balanced
```

Replace `balanced` with `evolutionist`, `guardian`, or `tactician` as needed.

## Watch one game

```powershell
npm run selfplay -- --games 1 --mode league --watch
```

The `--watch` option prints the first game's moves, inherited powers and the personality making each move. This is terminal playback, not a graphical board viewer.

## Available controls

```text
--games N        Number of games (1..100000), default 100
--mode league    Rotate the four personalities through pairings (default)
--mode self      Same selected personality on both sides
--personality ID balanced | evolutionist | guardian | tactician
--depth N        Search depth (1..8), default 1
--time-ms N      Per-move search time budget (50..60000 ms), default 80
--max-nodes N    Per-move node budget, default 2500
--max-plies N    Safety draw limit (20..500), default 120
--out PATH       Output directory
--watch          Print moves from the first game
--quiet          Suppress progress lines
```

## Draw and endless-game protection

The runner stops games by:

1. Checkmate or stalemate from the chess engine.
2. Three occurrences of the same position, including side-to-move, en-passant and piece movement capabilities.
3. 100 consecutive half-moves without a pawn move or capture (the 50-move-style draw rule for this training runner).
4. A configurable maximum-ply safety limit (default 120).

These extra draw adjudications are applied by the self-play runner only. The normal browser game's rules are not modified by this tool.

## Output files

Each run creates a new folder under `data/self-play/` by default:

- `games.jsonl`: one completed game per line, including move records, capture/inheritance counts, result, termination and search diagnostics.
- `positions.jsonl`: one board position per line, including current powers, side to move, selected move, search data, and final result labels from White's and side-to-move perspectives.
- `summary.json`: overall results, termination counts, personality leaderboard, pairings and aggregate statistics.
- `manifest.json`: parameters, data schema and limitations for the run.

The generated `positions.jsonl` is useful raw experience data for future training and evaluation. It is **not yet a trained neural network** and it does not automatically change the AI's weights. Stage 2 will use tournaments to tune/evaluate profiles; a later stage can convert the dataset into targets for a neural-network trainer.

## Important limitations

- Self-play searches are CPU-based. A GPU is not needed for these games.
- The four personalities are handcrafted evaluation profiles. They are not independently trained agents. In a same-personality self-match, the leaderboard records one self-match and does not claim a win/loss for the personality.
- Search depth/time/nodes still control playing strength; use equal search budgets when comparing personalities. Opening exploration is deliberately shallow and should be disabled with `--opening-random-plies 0` for deterministic search-only tests.
- Results from a small tournament are noisy. Use color swaps and many opponents before drawing conclusions.
- The browser app and Render server are not involved; run the lab on your own PC.
