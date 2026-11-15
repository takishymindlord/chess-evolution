import express from 'express';
import http from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { createInitialState, playMove } from './public/engine.js';
import { trainingManager } from './scripts/training-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.ALLOWED_ORIGIN || true, methods: ['GET', 'POST'] },
  pingInterval: 25000,
  pingTimeout: 20000
});

const PORT = Number(process.env.PORT || 3000);
const SAVED_GAMES_DIR = process.env.SAVED_GAMES_DIR || path.join(__dirname, 'data', 'saved-games');
const rooms = new Map();
const socketRooms = new Map();

app.use(express.json({ limit: '3mb' }));
app.use(express.static(path.join(__dirname, 'public')));
const isProduction = process.env.NODE_ENV === 'production';
const trainingApiKey = String(process.env.TRAINING_API_KEY || '').trim();
// Keep the expensive training endpoint closed in production unless the owner
// configures a private key. Local development remains friction-free.
const trainingApiAllowed = !isProduction || Boolean(trainingApiKey);
const trainingAccessRequired = isProduction || Boolean(trainingApiKey);

function hasValidTrainingKey(req) {
  if (!trainingAccessRequired) return true;
  if (!trainingApiKey) return false;
  const supplied = Buffer.from(String(req.get('x-training-key') || ''));
  const expected = Buffer.from(trainingApiKey);
  return expected.length > 0 && supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function requireTrainingAccess(req, res) {
  if (!trainingApiAllowed) {
    res.status(503).json({ error: 'Training is disabled. Configure TRAINING_API_KEY in your server environment, then redeploy.' });
    return false;
  }
  if (!hasValidTrainingKey(req)) {
    res.status(401).json({ error: 'A valid training access key is required. Enter the key configured by the server owner in the Training Lab.' });
    return false;
  }
  return true;
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'chess-evolution', rooms: rooms.size, training: trainingApiAllowed }));

function validArchiveKey(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function archiveDirectory(libraryKey) {
  const folder = createHash('sha256').update(libraryKey.toLowerCase()).digest('hex');
  return path.join(SAVED_GAMES_DIR, folder);
}

function validSavedGame(game) {
  if (!game || typeof game !== 'object' || Array.isArray(game)) return false;
  if (typeof game.id !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(game.id)) return false;
  if (!Array.isArray(game.moves) || game.moves.length > 1500) return false;
  if (!game.initialState || !Array.isArray(game.initialState.board) || game.initialState.board.length !== 8) return false;
  if (!game.players || typeof game.players !== 'object') return false;
  const serialized = JSON.stringify(game);
  if (Buffer.byteLength(serialized, 'utf8') > 256 * 1024) return false;
  return true;
}

async function readArchiveGames(libraryKey) {
  const directory = archiveDirectory(libraryKey);
  let names;
  try { names = await readdir(directory); }
  catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  const games = [];
  for (const name of names.filter((entry) => entry.endsWith('.json')).slice(0, 1000)) {
    try {
      const game = JSON.parse(await readFile(path.join(directory, name), 'utf8'));
      if (validSavedGame(game)) games.push(game);
    } catch { /* Ignore an incomplete or invalid archive file. */ }
  }
  return games.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
}

app.get('/api/saved-games', async (req, res) => {
  const libraryKey = String(req.get('x-archive-key') || '').toLowerCase();
  if (!validArchiveKey(libraryKey)) return res.status(400).json({ error: 'A valid 64-character archive key is required.' });
  try {
    const games = await readArchiveGames(libraryKey);
    res.set('Cache-Control', 'no-store');
    res.json({ games, count: games.length });
  } catch (error) {
    console.error('Saved-game archive read failed:', error);
    res.status(500).json({ error: 'The cloud game archive could not be read.' });
  }
});

app.post('/api/saved-games/sync', async (req, res) => {
  const libraryKey = String(req.get('x-archive-key') || '').toLowerCase();
  const games = req.body?.games;
  if (!validArchiveKey(libraryKey)) return res.status(400).json({ error: 'A valid 64-character archive key is required.' });
  if (!Array.isArray(games) || games.length > 20) return res.status(400).json({ error: 'Sync accepts between 1 and 20 games per request.' });
  if (games.some((game) => !validSavedGame(game))) return res.status(400).json({ error: 'One or more saved games are invalid or too large.' });
  try {
    const directory = archiveDirectory(libraryKey);
    await mkdir(directory, { recursive: true });
    const stored = [];
    for (const game of games) {
      const target = path.join(directory, `${game.id}.json`);
      const temporary = `${target}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(game), { mode: 0o600 });
      await rename(temporary, target);
      stored.push(game.id);
    }
    res.json({ ok: true, stored });
  } catch (error) {
    console.error('Saved-game archive write failed:', error);
    res.status(507).json({ error: 'The server could not persist these games. Check its storage configuration.' });
  }
});

app.delete('/api/saved-games/:gameId', async (req, res) => {
  const libraryKey = String(req.get('x-archive-key') || '').toLowerCase();
  const gameId = String(req.params.gameId || '');
  if (!validArchiveKey(libraryKey)) return res.status(400).json({ error: 'A valid 64-character archive key is required.' });
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(gameId)) return res.status(400).json({ error: 'Invalid saved-game ID.' });
  try {
    await unlink(path.join(archiveDirectory(libraryKey), `${gameId}.json`)).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
    res.json({ ok: true, deleted: gameId });
  } catch (error) {
    console.error('Saved-game archive delete failed:', error);
    res.status(500).json({ error: 'The saved game could not be removed from the cloud archive.' });
  }
});


app.get('/api/training/status', async (_req, res) => {
  await trainingManager.ready;
  res.set('Cache-Control', 'no-store');
  res.json({ ...trainingManager.getStatus(), enabled: trainingApiAllowed });
});

app.get('/api/training/model', async (_req, res) => {
  await trainingManager.ready;
  res.set('Cache-Control', 'no-store');
  res.json(trainingManager.getModel());
});

app.post('/api/training/start', async (req, res) => {
  if (!requireTrainingAccess(req, res)) return;
  try {
    const status = await trainingManager.start(req.body || {});
    res.status(202).json(status);
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : 'Training could not be started.' });
  }
});

app.post('/api/training/stop', (req, res) => {
  if (!requireTrainingAccess(req, res)) return;
  res.json(trainingManager.stop());
});

function cleanName(value) {
  const name = String(value || 'Player').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 18);
  return name || 'Player';
}

function newRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function presenceFor(room) {
  return {
    white: Boolean(room.players.white?.socketId),
    black: Boolean(room.players.black?.socketId)
  };
}

function publicPlayers(room) {
  return {
    white: room.players.white ? { name: room.players.white.name } : null,
    black: room.players.black ? { name: room.players.black.name } : null
  };
}

function roomPayload(code, room, color) {
  return {
    code,
    color,
    state: room.state,
    players: publicPlayers(room),
    presence: presenceFor(room)
  };
}

function broadcastPresence(code, room) {
  io.to(code).emit('room-presence', {
    code,
    players: publicPlayers(room),
    presence: presenceFor(room)
  });
}

function detachSocketFromRoom(socket, notify = true) {
  const code = socketRooms.get(socket.id);
  if (!code) return;
  const room = rooms.get(code);
  socketRooms.delete(socket.id);
  socket.leave(code);
  if (!room) return;
  for (const color of ['white', 'black']) {
    const player = room.players[color];
    if (player?.socketId === socket.id) player.socketId = null;
  }
  if (notify) broadcastPresence(code, room);
}

io.on('connection', (socket) => {
  socket.on('create-room', ({ playerId, name } = {}) => {
    if (typeof playerId !== 'string' || playerId.length > 100) {
      socket.emit('room-error', 'Unable to identify this player. Refresh and try again.');
      return;
    }
    detachSocketFromRoom(socket, false);
    const code = newRoomCode();
    const room = {
      state: createInitialState(),
      players: {
        white: { id: playerId, name: cleanName(name), socketId: socket.id },
        black: null
      }
    };
    rooms.set(code, room);
    socket.join(code);
    socketRooms.set(socket.id, code);
    socket.emit('room-created', roomPayload(code, room, 'white'));
    broadcastPresence(code, room);
  });

  socket.on('join-room', ({ code: rawCode, playerId, name, reconnect } = {}) => {
    const code = String(rawCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 6 || typeof playerId !== 'string' || playerId.length > 100) {
      socket.emit('room-error', 'Enter a valid six-character room code.');
      return;
    }
    const room = rooms.get(code);
    if (!room) {
      socket.emit('room-error', 'That room was not found. Check the code and try again.');
      return;
    }

    let color = null;
    for (const side of ['white', 'black']) {
      if (room.players[side]?.id === playerId) color = side;
    }
    if (!color) {
      if (!room.players.black) color = 'black';
      else {
        socket.emit('room-error', 'This room already has two players.');
        return;
      }
    }

    detachSocketFromRoom(socket, false);
    const oldSocketId = room.players[color]?.socketId;
    if (oldSocketId && oldSocketId !== socket.id) {
      const oldSocket = io.sockets.sockets.get(oldSocketId);
      if (oldSocket) oldSocket.leave(code);
      socketRooms.delete(oldSocketId);
    }
    room.players[color] = { id: playerId, name: cleanName(name || room.players[color]?.name), socketId: socket.id };
    socket.join(code);
    socketRooms.set(socket.id, code);
    socket.emit('room-joined', roomPayload(code, room, color));
    broadcastPresence(code, room);
    if (reconnect) socket.emit('game-state', { code, state: room.state, players: publicPlayers(room), presence: presenceFor(room) });
  });

  socket.on('make-move', ({ code: rawCode, from, to, promotion } = {}) => {
    const code = String(rawCode || '').toUpperCase();
    const room = rooms.get(code);
    if (!room || socketRooms.get(socket.id) !== code) {
      socket.emit('move-error', 'You are no longer connected to this room.');
      return;
    }
    const color = ['white', 'black'].find((side) => room.players[side]?.socketId === socket.id);
    if (!color) {
      socket.emit('move-error', 'Your player seat is no longer active. Rejoin the room.');
      return;
    }
    if (!room.players.white || !room.players.black) {
      socket.emit('move-error', 'Waiting for the second player to join.');
      return;
    }
    if (room.state.turn !== color) {
      socket.emit('move-error', 'It is your opponent’s turn.');
      return;
    }
    try {
      playMove(room.state, from, to, promotion);
      const update = {
        code,
        state: room.state,
        players: publicPlayers(room),
        presence: presenceFor(room)
      };
      io.to(code).emit('game-state', update);
      // Send an explicit terminal event as well as the regular state update so
      // both clients always run the winner dialog when checkmate/stalemate occurs.
      if (room.state.gameOver) io.to(code).emit('match-ended', update);
    } catch (error) {
      socket.emit('move-error', error instanceof Error ? error.message : 'That move could not be completed.');
    }
  });

  socket.on('restart-game', ({ code: rawCode } = {}) => {
    const code = String(rawCode || '').toUpperCase();
    const room = rooms.get(code);
    if (!room || socketRooms.get(socket.id) !== code) return;
    if (!room.players.white?.socketId || !room.players.black?.socketId) {
      socket.emit('move-error', 'Both players must be connected to start a new game.');
      return;
    }
    room.state = createInitialState();
    io.to(code).emit('match-restarted', { code, state: room.state });
  });

  socket.on('leave-room', ({ code: rawCode } = {}) => {
    const code = String(rawCode || '').toUpperCase();
    if (socketRooms.get(socket.id) !== code) return;
    io.to(code).except(socket.id).emit('room-closed', 'A player left the match. Create a new room to play again.');
    const room = rooms.get(code);
    if (room) {
      for (const color of ['white', 'black']) {
        const player = room.players[color];
        if (player?.socketId) {
          const other = io.sockets.sockets.get(player.socketId);
          if (other) {
            other.leave(code);
            socketRooms.delete(other.id);
          }
        }
      }
    }
    rooms.delete(code);
    socketRooms.delete(socket.id);
    socket.leave(code);
  });

  socket.on('disconnect', () => detachSocketFromRoom(socket, true));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Chess Evolution listening on http://localhost:${PORT}`);
});
