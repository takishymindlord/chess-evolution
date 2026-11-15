# Chess Evolution v1.9.1

> Updated v1.9.1 documentation. Older version notes below describe historical milestones; where they conflict with the current features, the latest sections take precedence.

Chess Evolution is a browser chess game with cumulative capture inheritance, online room-based multiplayer, and local pass-and-play.

## Modes

- **Online multiplayer:** create a six-character room code and share it with someone anywhere in the world. Both players open the same public website; Socket.IO synchronizes moves and the server validates them.
- **Local pass-and-play:** two people share one phone, tablet, or computer. Enter the second player's name and choose **Play Locally**. Before starting, choose whether the board rotates toward the player to move or stays fixed with White at the bottom. The orientation can also be toggled during a local match. Local mode does not require a network connection once the app has loaded.

## Phone and tablet support

The site is responsive and installable as a Progressive Web App (PWA).

- **Android:** open the public website in Chrome and choose **Install app** or **Add to Home screen** from the browser menu. The site may also show its own Install App button when Chrome offers the install prompt.
- **iPhone/iPad:** open the website in Safari, tap **Share**, then choose **Add to Home Screen**.
- After the first successful load, the service worker caches the app shell so local pass-and-play can open offline. Online rooms still require an internet connection.

## Run on your computer

Requires Node.js 22 or newer. The official current LTS download is at <https://nodejs.org/en/download/>.

```bash
npm install
npm start
```

Open <http://localhost:3000>. Choose **Play Locally** for two players on the same device, or use **Create a Room** and open the site in a second browser session to test online multiplayer.

Run the rules tests with:

```bash
npm test
```

## Publish online (Render)

### Enable the live Training Lab securely

Production self-play training is disabled until the server owner sets a private `TRAINING_API_KEY`. In Render, open the web service → **Environment** → **Add Environment Variable**, set the key to `TRAINING_API_KEY`, and use a long random value. Generate one on a computer with Node.js using:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Save the environment change and redeploy. Open the live Chess Evolution app, paste the same value into **Training Access Key** in the Self-Play Training Lab, and press **Save Key**. The browser keeps it only for the current tab session. The key protects the CPU-intensive start/stop endpoints; do not put it in source code, `render.yaml`, or a public GitHub commit. Local development does not need a key.

This project includes a `render.yaml` Blueprint and a `Dockerfile`.

1. Create a GitHub repository and upload the contents of this project folder (the files inside `chess-evolution`, not the ZIP archive itself).
2. Sign in to <https://render.com> and connect the GitHub repository.
3. Choose **New → Blueprint** and select the repository. Render reads `render.yaml`. Alternatively, create a **Web Service** with runtime `Node`, build command `npm install`, start command `npm start`, and health-check path `/health`.
4. Deploy. When the service reports **Live**, copy its public `onrender.com` URL and share it with players.
5. Each player opens that same URL on a phone or computer. One creates a room; the other joins with the six-character code.

Render web services support server-side applications and WebSockets. Free instances are useful for a first test, but Render may spin a free service down after 15 minutes without inbound HTTP requests or WebSocket messages. Waking it can take about a minute. For a continuously available public game, use an always-on paid instance. See <https://render.com/docs/free> and <https://render.com/docs/web-services>.

## Hosting notes

- The server binds to `0.0.0.0` and uses the hosting provider's `PORT` environment variable.
- The `/health` route is provided for service health checks.
- Room state is currently stored in server memory. A server restart, redeploy, or sleep/wake restart can clear live rooms. This build does not yet have user accounts, persistent match storage, or multi-instance shared state.
- For a larger production deployment, add a persistent database and a shared Socket.IO adapter (such as Redis) before scaling to multiple server instances.

## Piece appearance and preferences

- The **VISUAL: ICONS / VISUAL: MERGED** button changes how hybrid pieces appear. The icon style shows one small symbol for each additional movement capability. The merged style replaces the ordinary glyph with one integrated metallic SVG sculpture: crowns, horse-head silhouettes, bishop details, and rook battlements are fused into the overall piece shape rather than placed in corner badges. A piece with queen, rook, bishop, and knight capabilities keeps the star emblem as its maximum form.
- Visual preference is saved locally in each browser/device. In an online match, the two players can choose different appearances without changing the shared match state or the other player's view.
- In local play, the visual style applies to the shared device for both players.

## Inheritance and capture history

- Capturing a piece grants its movement type plus every special power it had already inherited.
- Capturing a pawn does not grant pawn movement. If that pawn had inherited special powers, those powers still pass to the capturing piece.
- A pawn retains its own pawn rules while adding inherited rook, bishop, knight, or queen movement.
- Capabilities are stored as a set: capturing another piece with an already-owned movement type does not add a duplicate capability or a duplicate badge. A piece also does not display its own native movement as an inherited badge.
- Select any piece to open its **Capture History** tree. It shows the pieces that unit captured and nested branches from captured pieces that had captured others. When an evolved piece is captured, its complete nested capture tree moves with it to the capturing piece.
- The maximum-hybrid star appears in both Icons and Merged visual modes when a unit has all four special movement types: queen, rook, bishop, and knight.
- At checkmate or stalemate, a native browser result dialog announces the winner (or draw) for local games and both online players. Players can close it or open the statistics view, which shows each side's moves, captures, newly acquired abilities, promotions, and most-evolved surviving unit.
- Standard king safety, check, checkmate, stalemate, castling, en passant, and promotion are included.


## v1.4.0 visual and result-screen update

- Added `public/merged-art.js`, which renders unique fused vector artwork for the current set of movement capabilities. The art is generated on the client and does not change the server-side chess rules or shared game state.
- Retained the four-power star as the maximum evolution form. Kings remain ordinary kings and never render hybrid art.
- Added a modal match-end announcement for checkmate and stalemate, with **View Statistics** and **Close** actions. The statistics view can return to the result announcement or close back to the board.
- Updated the service-worker cache to `v4` and precached the new art module so installed PWA clients receive the new renderer.
- Automated coverage includes fused-art combinations, the maximum star, and the immutable king.


## Version 1.5.0 updates

- Maximum hybrids (Queen, Rook, Bishop and Knight capabilities together) use the star mark in both Icons and Merged visual modes.
- Match completion opens a native browser modal with the winner/draw announcement and a Statistics or Close choice. Online matches broadcast an explicit `match-ended` event to both players.
- Front page credit: Created by TakishyMindlord Labs.
- PWA cache version bumped to v5 and includes the new `piece-visuals.js` module.


## Play against the computer (v1.7)

The lobby includes a local **Play Against Computer** mode. The AI runs in a browser Web Worker, so its search does not block board interaction. Choose White or Black and one of five initial search presets. The engine uses the same Chess Evolution legal-move and capture-inheritance rules as human play.

The AI now uses iterative-deepening negamax, alpha-beta pruning, a transposition table, quiescence search, killer/history move ordering, and an evolution-aware tactical evaluator. It values unique inherited movement powers and useful capability combinations, penalizes exposed evolved pieces, rewards defended units and multi-target pressure, and searches forcing capture sequences beyond the nominal depth. It also recognizes forced checkmates, including the finishing move from the supplied 31-move test game. It does not yet use a trained neural network. The difficulty presets limit search depth, time, and nodes; they remain initial settings and have not been calibrated through tournament play.

To test: start the project with `npm start`, open `http://localhost:3000`, select a side and difficulty in **Play Against Computer**, and start a match. Computer play runs locally and does not require a live Render server once the app assets are available.


## v1.7.0 AI tactical upgrade

- Added quiescence search so the engine continues through forcing captures and check evasions instead of evaluating immediately after a capture sequence begins.
- Added a transposition table with exact/lower/upper bounds and mate-distance score normalization.
- Added killer-move and history heuristics alongside capture, promotion, inheritance-gain and previous-best-move ordering.
- Improved evaluation of unique acquired powers, power synergies, advanced pawns, king shelter, attacked/undefended hybrids, and multi-target pressure (fork-like threats).
- Added bulk attack maps to the chess engine so threat evaluation can inspect all squares with one board pass per side.
- Added regression tests for checkmate-in-one, avoiding a poisoned capture, evaluating exposed evolved pieces, transposition reuse, bulk attack-map consistency, and the finishing move from the supplied 31-move human test game.
- Bumped the service-worker cache to `v7`; no new runtime dependencies are required.

The AI is still search-based and uses handcrafted evaluation weights. Neural-network training and calibrated strength ratings are future work.

## v1.8.0 — Self-Play Training Lab

A separate local Node.js self-play runner has been added for AI-vs-AI tournaments and experience-data generation. It does not add a public in-browser AI-vs-AI button and it does not use the Render server; run it on your development PC.

Install dependencies and run tests:

```powershell
npm install
npm test
```

Run a small ten-game pilot:

```powershell
npm run selfplay -- --games 10 --depth 1 --time-ms 50 --max-nodes 1200 --max-plies 100 --watch
```

Run the default 100-game personality league:

```powershell
npm run selfplay -- --games 100 --depth 1 --time-ms 80 --max-nodes 2500 --max-plies 120
```

The lab pits four handcrafted evaluation personalities against one another: Balanced, Evolutionist, Guardian and Tactician. It rotates round-robin pairings and swaps colors in the return game. Use `--mode self --personality balanced` to have one personality play itself. `--watch` prints the first game's moves in the terminal. To reduce repetitive openings, the first four plies use seeded exploration among legal moves whose static evaluation is within eight centipawns of the best candidate; later moves use the regular search. Supply `--seed N` to reproduce a run or use a different seed to generate alternative openings.

Each run writes `games.jsonl`, `positions.jsonl`, `summary.json` and `manifest.json` to a timestamped folder under `data/self-play/`. Position records include the inherited capability set, selected move, search diagnostics and final outcome labels for later training experiments.

Draw protection in the runner includes threefold repetition, a 100-half-move quiet-move rule, and a configurable maximum-ply limit. These runner adjudications do not modify the browser chess rules.

**Historical note (v1.8.0):** At that milestone, the personality league only generated data and did not update AI weights. In v1.9.0, the separate `npm run train` pipeline and lobby Training Lab perform parallel self-play and fit a compact linear evaluation model. See `SELF-PLAY-LAB.md` for current instructions.


## v1.9.1 — Secure live Training Lab access

The browser rules engine now tracks rule-relevant position history and the half-move clock. Local, online, player-vs-AI and AI-vs-AI games automatically finish as a draw on threefold repetition or after 100 half-moves without a pawn move or capture. Position identity retains castling/pawn-move rights and inherited powers. The AI search also detects revisited positions and treats them as an undesirable draw line to discourage loops before the automatic draw triggers.

The lobby now includes a **Self-Play Training Lab**. It launches multiple Node worker threads (limited by available CPU cores) to run the selected number of games in parallel. Each training game runs identical copies of the current agent against one another; this is separate from the four fixed strategy profiles used by the older CLI league. Every pre-move position is saved with nine white-perspective evaluation features and the final game result.

After self-play, the trainer runs mini-batch logistic regression over those labeled positions and updates nine evaluation weights: material, inheritance, synergy, center control, pawn advancement, exposure, protection, forks, and king safety. The resulting compact linear evaluation model is saved to `data/training/current-model.json`, along with a generation-specific `games.jsonl`, `positions.jsonl`, `model.json`, and `summary.json`. Browser AI search loads the saved weights and uses them for subsequent games. This is supervised weight learning, not a deep neural network; a lower validation loss is a useful training signal, but it does not by itself prove a higher playing strength.

To train from the browser, run `npm install`, `npm start`, open `http://localhost:3000`, and use **Self-Play Training Lab**. The recommended first run is 200 games, 4 workers, depth 2. The worker count is capped by available CPU cores. To use the same pipeline from a terminal, run:

```bash
npm run train -- --games 200 --workers 4 --depth 2
```

Use a smaller test run before a large session:

```bash
npm run train -- --games 8 --workers 2 --depth 1 --max-plies 30
```

Training data is written to the filesystem of the computer running the server. The training API is enabled by default for local development. In production, the start/stop endpoints require the private `TRAINING_API_KEY` configured by the server owner and entered in the Training Lab. The key is never stored in the project source.


## v1.10.0 — Saved Games archive and timed replay

Every completed match (online multiplayer, local pass-and-play, player vs AI, and AI vs AI watch mode) offers an optional **Save Match** action. A saved record includes the starting board, player labels, result, complete move sequence, Evolution capture/inheritance history, promotions, and a timestamp for every move.

Saved records are stored first in browser IndexedDB on the device. This makes saving available while offline and keeps a durable local copy that is not tied to the server or GitHub. When the device is online, the app attempts to synchronize the archive to the Node server. A private 64-character archive key identifies the user's archive; link another device by copying that key into **Saved Games → Private Archive Sync Key**. Keep this key secret. Export/Import Backup is also available for manual transfer and backup.

The **Saved Games** view lists saved matches and opens a replay on the normal Evolution board. Replay rebuilds the match by applying each recorded legal move through the same engine, so promotions, captures, and inherited capabilities are recreated. The default **Original timing** option uses the measured gap between each move (including the first move from match start), preserving thinking pauses. Playback can also be changed to 0.5×, 1×, 2×, or 4×, paused, stepped, or restarted.

Server archive copies are stored under `data/saved-games/` by default, not in GitHub. On Render, the default filesystem is ephemeral: the browser's local IndexedDB copy stays on that device, but server copies can disappear after restarts or deployments. To retain server copies across deployments, attach a paid Render persistent disk mounted at `/var/data` and set `SAVED_GAMES_DIR=/var/data/saved-games`; Render documents that persistent disks preserve files under their mount path, while default filesystems are ephemeral. See [Render Persistent Disks](https://render.com/docs/disks).

Self-play training scripts and the Training Lab remain in this build for occasional local PC training. They are not removed or replaced by the saved-game feature. Training datasets and generation logs stay out of Git by default, but `data/training/current-model.json` is deliberately allowed through `.gitignore`: after training on your PC, you can commit and push that one model file so the deployed app can load the updated evaluation weights. The server reads it at startup and the browser fetches the current model for AI searches. Do not commit `data/saved-games/`; those are player match records, not source code.
