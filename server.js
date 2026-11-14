import express from 'express';
import http from 'node:http';
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
const rooms = new Map();
const socketRooms = new Map();

app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));
const trainingApiAllowed = process.env.NODE_ENV !== 'production' || process.env.ENABLE_TRAINING_API === 'true';
app.get('/health', (_req, res) => res.json({ ok: true, service: 'chess-evolution', rooms: rooms.size, training: trainingApiAllowed }));

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
  if (!trainingApiAllowed) return res.status(403).json({ error: 'Training API is disabled on this production server. Run the project locally or set ENABLE_TRAINING_API=true.' });
  try {
    const status = await trainingManager.start(req.body || {});
    res.status(202).json(status);
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : 'Training could not be started.' });
  }
});

app.post('/api/training/stop', (req, res) => {
  if (!trainingApiAllowed) return res.status(403).json({ error: 'Training API is disabled on this production server.' });
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
