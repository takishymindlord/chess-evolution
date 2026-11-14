# Chess Evolution

Chess Evolution is a browser chess game with cumulative capture inheritance, online room-based multiplayer, and local pass-and-play.

## Modes

- **Online multiplayer:** create a six-character room code and share it with someone anywhere in the world. Both players open the same public website; Socket.IO synchronizes moves and the server validates them.
- **Local pass-and-play:** two people share one phone, tablet, or computer. Enter the second player's name and choose **Play Locally**. The board automatically rotates to face the player whose turn it is. Local mode does not require a network connection once the app has loaded.

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

## Inheritance rules

- Capturing a piece grants its movement type plus every power it had already inherited.
- Capturing a pawn does not grant pawn movement. If that pawn had inherited special powers, those powers still pass to the capturing piece.
- A pawn retains its own pawn rules while adding inherited rook, bishop, knight, or queen movement.
- Duplicate powers remain in the lineage display. Movement uses the union of the movement types, so duplicate copies are recorded but do not create a new variation of an already-owned move set.
- Standard king safety, check, checkmate, stalemate, castling, en passant, and promotion are included.
