import { createInitialState, getLegalMoves, PIECE_NAMES, playMove, squareToCoords } from './engine.js';
import { getArchiveKey, setArchiveKey, listSavedGames, putSavedGame, putSavedGames, removeSavedGame, getDeletedGameIds, rememberDeletedGame, forgetDeletedGame } from './game-storage.js';
import { scaledMoveDelay, formatElapsed } from './game-replay.js';
import { mergedPieceSvg } from './merged-art.js';
import { getPieceVisualMode } from './piece-visuals.js';

const $ = (id) => document.getElementById(id);
const socket = typeof window.io === 'function' ? window.io({ transports: ['websocket', 'polling'] }) : null;
const glyphs = {
  white: { king: '♔', queen: '♕', rook: '♖', bishop: '♗', knight: '♘', pawn: '♙' },
  black: { king: '♚', queen: '♛', rook: '♜', bishop: '♝', knight: '♞', pawn: '♟' }
};
const tinyGlyphs = { king: '♚', queen: '♛', rook: '♜', bishop: '♝', knight: '♞', pawn: '♟' };
const powerSort = ['queen', 'rook', 'bishop', 'knight', 'king'];
const settingsKeys = { orientation: 'chessEvolution.localOrientation', visual: 'chessEvolution.visualStyle' };
const readSetting = (key, fallback) => { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } };

const playerId = getOrCreatePlayerId();
let roomCode = null;
let myColor = null;
let gameMode = 'online';
let gameState = null;
let initialGameState = null;
let activeScreen = 'lobby';
let savedGamesReturnScreen = 'lobby';
let replayRecord = null;
let replayIndex = 0;
let replayPlaying = false;
let replayTimer = null;
let replaySpeed = 'original';
let replayReturnContext = null;
let currentMatchSavedId = null;
let players = { white: null, black: null };
let presence = { white: false, black: false };
let selected = null;
let legalMoves = [];
let pendingPromotion = null;
let toastTimer = null;
let localOrientation = readSetting(settingsKeys.orientation, 'rotate') === 'fixed' ? 'fixed' : 'rotate';
let visualStyle = readSetting(settingsKeys.visual, 'icons') === 'merged' ? 'merged' : 'icons';
let endPopupShown = false;
let aiWorker = null;
let aiRequestId = 0;
let aiThinking = false;
let aiDifficulty = 'medium';
let aiWatchWhiteDifficulty = 'medium';
let aiWatchBlackDifficulty = 'medium';
let aiWatchDelayMs = 500;
let aiWatchTimer = null;
let learnedEvaluationModel = null;
let trainingPollTimer = null;

const TRAINING_KEY_SESSION = 'chessEvolution.trainingApiKey';
function getTrainingApiKey() {
  try { return sessionStorage.getItem(TRAINING_KEY_SESSION) || ''; }
  catch { return ''; }
}
function trainingAuthHeaders() {
  const key = getTrainingApiKey();
  return key ? { 'x-training-key': key } : {};
}

function invalidateAiSearch() {
  aiRequestId += 1;
  aiThinking = false;
  if (aiWatchTimer) { clearTimeout(aiWatchTimer); aiWatchTimer = null; }
  // Terminating the worker cancels any search that is still running, so an
  // abandoned position cannot delay the next match's opening calculation.
  if (aiWorker) {
    aiWorker.terminate();
    aiWorker = null;
  }
}

function getAiWorker() {
  if (aiWorker) return aiWorker;
  if (typeof Worker !== 'function') throw new Error('This browser does not support background AI workers. Please use an updated browser.');
  aiWorker = new Worker('/ai-worker.js', { type: 'module', name: 'chess-evolution-ai' });
  aiWorker.addEventListener('message', handleAiWorkerMessage);
  aiWorker.addEventListener('error', (event) => {
    aiThinking = false;
    if ((gameMode === 'computer' || gameMode === 'aiwatch') && gameState && !gameState.gameOver) {
      renderStatus();
      toast(`The computer engine encountered an error: ${event.message || 'unknown worker error'}`);
    }
  });
  return aiWorker;
}

function searchSnapshot(state) {
  // Send only rule-relevant data to the worker. Capture trees and move notation
  // are presentation/history data and needlessly enlarge worker messages.
  return {
    board: state.board.map((row) => row.map((piece) => piece ? {
      id: piece.id,
      color: piece.color,
      type: piece.type,
      powers: [...(piece.powers || [])],
      hasMoved: Boolean(piece.hasMoved)
    } : null)),
    turn: state.turn,
    enPassant: state.enPassant ? { ...state.enPassant } : null,
    moveNumber: state.moveNumber,
    halfmoveClock: state.halfmoveClock || 0,
    positionCounts: state.positionCounts || {},
    status: state.status,
    winner: null,
    check: state.check,
    gameOver: false
  };
}

function requestComputerMove() {
  if (gameMode !== 'computer' || !gameState || gameState.gameOver || gameState.turn === myColor || aiThinking) return;
  try {
    const worker = getAiWorker();
    aiThinking = true;
    const requestId = ++aiRequestId;
    renderStatus();
    worker.postMessage({
      type: 'search',
      requestId,
      difficulty: aiDifficulty,
      state: searchSnapshot(gameState),
      model: learnedEvaluationModel
    });
  } catch (error) {
    aiThinking = false;
    renderStatus();
    toast(error instanceof Error ? error.message : 'The computer could not start thinking.');
  }
}

function handleAiWorkerMessage(event) {
  const message = event.data || {};
  if (message.requestId !== aiRequestId || !['computer', 'aiwatch'].includes(gameMode) || !gameState || gameState.gameOver) return;
  aiThinking = false;
  if (message.error) {
    renderStatus();
    toast(`AI search failed: ${message.error}`);
    return;
  }
  const move = message.result?.move;
  if (!move) {
    renderStatus();
    renderGame();
    return;
  }
  try {
    const { record } = playMove(gameState, move.from, move.to, 'queen');
    selected = null;
    legalMoves = [];
    renderGame();
    if (record.inherited?.length) {
      toast(`Evolution AI inherited ${record.inherited.map((type) => PIECE_NAMES[type]).join(' + ')}.`);
    } else {
      toast('Evolution AI played a move.');
    }
    if (gameMode === 'aiwatch' && !gameState.gameOver) {
      aiWatchTimer = setTimeout(() => { aiWatchTimer = null; requestAiWatchMove(); }, aiWatchDelayMs);
    }
  } catch (error) {
    renderStatus();
    toast(error instanceof Error ? `AI returned an invalid move: ${error.message}` : 'AI returned an invalid move.');
  }
}

function getOrCreatePlayerId() {
  let id = sessionStorage.getItem('chessEvolution.playerId');
  if (!id) {
    const randomPart = window.crypto?.randomUUID ? window.crypto.randomUUID() : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    id = `ce_${randomPart}`;
    sessionStorage.setItem('chessEvolution.playerId', id);
  }
  return id;
}

function getPlayerName() {
  const value = $('playerName')?.value?.trim();
  return (value || 'Player').slice(0, 18);
}

function setConnection(online, label) {
  $('connectionDot').classList.toggle('online', online);
  $('connectionText').textContent = label;
}

function showLobbyMessage(message, kind = '') {
  const el = $('lobbyMessage');
  el.textContent = message;
  el.className = `lobby-message ${kind}`.trim();
}

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visible'), 2600);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function setScreen(screen) {
  activeScreen = screen;
  $('lobbyScreen').classList.toggle('hidden', screen !== 'lobby');
  $('gameScreen').classList.toggle('hidden', screen !== 'game');
  $('savedGamesScreen').classList.toggle('hidden', screen !== 'saved');
  $('savedGamesNavBtn').classList.toggle('active', screen === 'saved');
}

function cloneData(value) {
  return JSON.parse(JSON.stringify(value));
}

function resetInitialGameState(state = gameState) {
  const initial = createInitialState();
  if (Number.isFinite(Number(state?.startedAt))) initial.startedAt = Number(state.startedAt);
  initialGameState = initial;
  currentMatchSavedId = null;
}

function clearReplayTimer() {
  if (replayTimer) clearTimeout(replayTimer);
  replayTimer = null;
}

function pauseReplay() {
  replayPlaying = false;
  clearReplayTimer();
  renderReplayControls();
  if (gameMode === 'replay' && gameState) renderStatus();
}

function savedSession() {
  try { return JSON.parse(sessionStorage.getItem('chessEvolution.lastRoom') || 'null'); }
  catch { return null; }
}

function saveSession() {
  sessionStorage.setItem('chessEvolution.lastRoom', JSON.stringify({ code: roomCode, playerId, name: getPlayerName() }));
}

function clearSession() {
  sessionStorage.removeItem('chessEvolution.lastRoom');
}

function startLocalGame() {
  invalidateAiSearch();
  endPopupShown = false;
  closeMatchEndDialog();
  gameMode = 'local';
  roomCode = null;
  myColor = 'white';
  gameState = createInitialState();
  resetInitialGameState(gameState);
  players = {
    white: { name: getPlayerName() },
    black: { name: ($('localOpponentName').value.trim() || 'Player 2').slice(0, 18) }
  };
  presence = { white: true, black: true };
  selected = null;
  legalMoves = [];
  pendingPromotion = null;
  clearSession();
  $('roomCodeLabel').textContent = 'LOCAL';
  $('roomChipLabel').textContent = 'MODE';
  $('matchModeLabel').textContent = 'LOCAL MATCH';
  $('copyRoomBtn').classList.add('hidden');
  setConnection(false, 'LOCAL MODE');
  setScreen('game');
  renderGame();
  toast('Local pass-and-play started. White moves first.');
}

function startComputerGame() {
  invalidateAiSearch();
  endPopupShown = false;
  closeMatchEndDialog();
  gameMode = 'computer';
  roomCode = null;
  myColor = $('computerSideSelect').value === 'black' ? 'black' : 'white';
  aiDifficulty = ['beginner', 'easy', 'medium', 'hard', 'expert'].includes($('computerDifficultySelect').value)
    ? $('computerDifficultySelect').value
    : 'medium';
  gameState = createInitialState();
  resetInitialGameState(gameState);
  const humanName = getPlayerName();
  players = myColor === 'white'
    ? { white: { name: humanName }, black: { name: 'Evolution AI' } }
    : { white: { name: 'Evolution AI' }, black: { name: humanName } };
  presence = { white: true, black: true };
  selected = null;
  legalMoves = [];
  pendingPromotion = null;
  clearSession();
  $('roomCodeLabel').textContent = 'VS AI';
  $('roomChipLabel').textContent = 'MODE';
  $('matchModeLabel').textContent = `VS COMPUTER · ${aiDifficulty.toUpperCase()}`;
  $('copyRoomBtn').classList.add('hidden');
  setConnection(false, 'AI MODE');
  setScreen('game');
  renderGame();
  toast(`Playing as ${myColor}. Evolution AI is ${myColor === 'white' ? 'Black' : 'White'}.`);
  if (gameState.turn !== myColor) requestComputerMove();
}

function startAiWatchGame() {
  invalidateAiSearch();
  endPopupShown = false;
  closeMatchEndDialog();
  gameMode = 'aiwatch';
  roomCode = null;
  myColor = 'white';
  aiWatchWhiteDifficulty = ['beginner', 'easy', 'medium', 'hard', 'expert'].includes($('aiWatchWhiteSelect').value) ? $('aiWatchWhiteSelect').value : 'medium';
  aiWatchBlackDifficulty = ['beginner', 'easy', 'medium', 'hard', 'expert'].includes($('aiWatchBlackSelect').value) ? $('aiWatchBlackSelect').value : 'medium';
  aiWatchDelayMs = Number($('aiWatchSpeedSelect').value) || 500;
  gameState = createInitialState();
  resetInitialGameState(gameState);
  players = {
    white: { name: `Evolution AI · ${aiWatchWhiteDifficulty.toUpperCase()}` },
    black: { name: `Evolution AI · ${aiWatchBlackDifficulty.toUpperCase()}` }
  };
  presence = { white: true, black: true };
  selected = null;
  legalMoves = [];
  pendingPromotion = null;
  clearSession();
  $('roomCodeLabel').textContent = 'AI VS AI';
  $('roomChipLabel').textContent = 'MODE';
  $('matchModeLabel').textContent = `AI VS AI · ${aiWatchWhiteDifficulty.toUpperCase()} / ${aiWatchBlackDifficulty.toUpperCase()}`;
  $('copyRoomBtn').classList.add('hidden');
  setConnection(false, 'AI LAB');
  setScreen('game');
  renderGame();
  toast('Evolution AI vs Evolution AI started.');
  requestAiWatchMove();
}

function requestAiWatchMove() {
  if (gameMode !== 'aiwatch' || !gameState || gameState.gameOver || aiThinking) return;
  try {
    const worker = getAiWorker();
    aiThinking = true;
    const requestId = ++aiRequestId;
    renderStatus();
    const difficulty = gameState.turn === 'white' ? aiWatchWhiteDifficulty : aiWatchBlackDifficulty;
    worker.postMessage({ type: 'search', requestId, difficulty, state: searchSnapshot(gameState), model: learnedEvaluationModel });
  } catch (error) {
    aiThinking = false;
    renderStatus();
    toast(error instanceof Error ? error.message : 'The AI watch mode could not start.');
  }
}

function createRoom() {
  if (!socket?.connected) return showLobbyMessage('The game server is not connected yet. Please try again.', 'error');
  $('createRoomBtn').disabled = true;
  socket.emit('create-room', { playerId, name: getPlayerName() });
}

function joinRoom() {
  if (!socket?.connected) return showLobbyMessage('The game server is not connected yet. Please try again.', 'error');
  const code = $('roomCodeInput').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 6) return showLobbyMessage('Enter the full six-character room code.', 'error');
  $('joinRoomBtn').disabled = true;
  socket.emit('join-room', { code, playerId, name: getPlayerName() });
}

function enterRoom(payload) {
  invalidateAiSearch();
  endPopupShown = false;
  closeMatchEndDialog();
  gameMode = 'online';
  roomCode = payload.code;
  myColor = payload.color;
  gameState = payload.state;
  resetInitialGameState(gameState);
  players = payload.players || { white: null, black: null };
  presence = payload.presence || { white: true, black: Boolean(players.black) };
  selected = null;
  legalMoves = [];
  saveSession();
  $('roomCodeLabel').textContent = roomCode;
  $('roomChipLabel').textContent = 'ROOM';
  $('matchModeLabel').textContent = 'LIVE MATCH';
  $('copyRoomBtn').classList.remove('hidden');
  setScreen('game');
  renderGame();
}

function emitMove(from, to, promotion = 'queen') {
  if (gameMode === 'local' || gameMode === 'computer') {
    try {
      const { record } = playMove(gameState, from, to, promotion);
      selected = null;
      legalMoves = [];
      renderGame();
      if (record.inherited?.length) {
        const sideName = gameMode === 'computer' && record.color !== myColor ? 'Evolution AI' : (record.color === 'white' ? 'White' : 'Black');
        toast(`${sideName} inherited ${record.inherited.map((type) => PIECE_NAMES[type]).join(' + ')}.`);
      }
      if (gameMode === 'computer' && !gameState.gameOver && gameState.turn !== myColor) requestComputerMove();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'That move could not be completed.');
    }
    return;
  }
  if (!socket?.connected || !roomCode) return toast('Connection lost. Reconnecting…');
  socket.emit('make-move', { code: roomCode, from, to, promotion });
}

function leaveRoom() {
  invalidateAiSearch();
  if (gameMode === 'online' && socket?.connected && roomCode) socket.emit('leave-room', { code: roomCode });
  roomCode = null;
  myColor = null;
  endPopupShown = false;
  closeMatchEndDialog();
  gameMode = 'online';
  gameState = null;
  players = { white: null, black: null };
  presence = { white: false, black: false };
  selected = null;
  clearSession();
  $('copyRoomBtn').classList.remove('hidden');
  $('roomChipLabel').textContent = 'ROOM';
  $('matchModeLabel').textContent = 'LIVE MATCH';
  setConnection(Boolean(socket?.connected), socket?.connected ? 'CONNECTED' : 'SERVER OFFLINE');
  setScreen('lobby');
  showLobbyMessage('You left the match. Create a room, join online, or start a local game.', 'success');
}

function boardPerspective() {
  if (gameMode === 'local') return localOrientation === 'rotate' ? gameState.turn : 'white';
  if (gameMode === 'replay' || gameMode === 'aiwatch') return 'white';
  return myColor;
}

function orderedSquares() {
  const result = [];
  const perspective = boardPerspective();
  const yValues = perspective === 'black' ? [7,6,5,4,3,2,1,0] : [0,1,2,3,4,5,6,7];
  const xValues = perspective === 'black' ? [7,6,5,4,3,2,1,0] : [0,1,2,3,4,5,6,7];
  for (const y of yValues) for (const x of xValues) result.push({ x, y });
  return result;
}

function squareName(x, y) { return `${'abcdefgh'[x]}${8-y}`; }

function renderBoard() {
  if (!gameState) return;
  const board = $('chessBoard');
  const legalKeys = new Set(legalMoves.map((move) => `${move.x},${move.y}`));
  const checkedKing = gameState.check ? findKing(gameState, gameState.check) : null;
  const lastMove = gameState.lastMove;
  board.innerHTML = orderedSquares().map(({ x, y }) => {
    const piece = gameState.board[y][x];
    const isSelected = selected?.x === x && selected?.y === y;
    const isLegal = legalKeys.has(`${x},${y}`);
    const isCapture = isLegal && (piece || (gameState.board[selected?.y]?.[x] && selected && gameState.enPassant?.x === x && gameState.enPassant?.y === y));
    const isLast = lastMove && ((lastMove.from.x === x && lastMove.from.y === y) || (lastMove.to.x === x && lastMove.to.y === y));
    const inCheck = checkedKing?.x === x && checkedKing?.y === y;
    const squareClass = [
      'square', (x+y)%2 === 0 ? 'light' : 'dark',
      isSelected ? 'selected' : '', isLegal ? (isCapture ? 'capture-target' : 'legal') : '',
      isLast ? 'last-move' : '', inCheck ? 'in-check' : ''
    ].filter(Boolean).join(' ');
    const perspective = boardPerspective();
    const bottomRank = perspective === 'black' ? y === 0 : y === 7;
    const leftFile = perspective === 'black' ? x === 7 : x === 0;
    const capabilities = piece ? pieceCapabilities(piece) : [];
    const isHybrid = capabilities.length > 0;
    const visualMode = piece ? getPieceVisualMode(piece, visualStyle) : 'icons';
    const identityMarkup = piece
      ? (visualMode === 'star'
        ? makeMaximumHybridStar(piece)
        : (visualMode === 'merged'
          ? makeMergedVisual(piece)
          : `<span class="piece-glyph">${glyphs[piece.color][piece.type]}</span>${isHybrid ? makePowerBadges(piece) : ''}`))
      : '';
    const pieceMarkup = piece ? `<span class="piece ${piece.color} ${isHybrid ? 'hybrid' : ''} ${visualMode === 'merged' ? 'merged-style' : ''} ${visualMode === 'star' ? 'max-hybrid-style' : ''}">${isHybrid ? '<span class="piece-halo"></span>' : ''}${identityMarkup}</span>` : '';
    return `<button class="${squareClass}" data-x="${x}" data-y="${y}" type="button" role="gridcell" aria-label="${squareName(x,y)}${piece ? ` ${piece.color} ${piece.type}` : ''}${isLegal ? ', legal move' : ''}">${pieceMarkup}${bottomRank ? `<span class="coord-file">${'abcdefgh'[x]}</span>` : ''}${leftFile ? `<span class="coord-rank">${8-y}</span>` : ''}</button>`;
  }).join('');
  board.querySelectorAll('.square').forEach((square) => {
    square.addEventListener('click', () => onSquareClick(Number(square.dataset.x), Number(square.dataset.y)));
  });
  renderCoordinates();
}

function pieceCapabilities(piece) {
  // A capability is displayed once, and a piece never badges its own native movement.
  // Kings are immutable and therefore never display inherited capabilities.
  if (!piece || piece.type === 'king') return [];
  return [...new Set(piece.powers || [])]
    .filter((type) => type !== 'pawn' && type !== 'king' && type !== piece.type)
    .sort((a, b) => powerSort.indexOf(a) - powerSort.indexOf(b));
}

function makeMaximumHybridStar(piece) {
  const colorLabel = piece.color === 'white' ? 'white' : 'black';
  return `<span class="merged-emblem merged-star max-hybrid-star" role="img" aria-label="Maximum hybrid ${colorLabel} piece" title="Maximum hybrid · all four special movement capabilities"><span>✦</span></span>`;
}

function makePowerBadges(piece) {
  const capabilities = pieceCapabilities(piece);
  if (!capabilities.length) return '';
  return `<span class="power-badges">${capabilities.map((type) => `<span class="power-badge" title="${PIECE_NAMES[type]} movement">${tinyGlyphs[type] || '✦'}</span>`).join('')}</span>`;
}

function makeMergedVisual(piece) {
  if (!pieceCapabilities(piece).length) return '';
  // Render one fused, full-size sculpture. The four-capability combination
  // is intentionally represented by the familiar star form.
  return mergedPieceSvg(piece);
}

function captureTreeCount(nodes = []) {
  return nodes.reduce((total, node) => total + 1 + captureTreeCount(node.captures || []), 0);
}

function renderCaptureTree(nodes = []) {
  if (!nodes.length) return '<div class="tree-empty">No captures in this piece’s history yet.</div>';
  return `<ul class="capture-tree-list">${nodes.map((node) => {
    const mark = glyphs[node.color]?.[node.type] || tinyGlyphs[node.type] || '✦';
    const inherited = [...new Set(node.powers || [])].filter((type) => type !== node.type && type !== 'pawn');
    const powers = inherited.length ? `<small>Abilities: ${inherited.map((type) => PIECE_NAMES[type]).join(', ')}</small>` : '';
    return `<li><div class="capture-tree-node"><span class="tree-piece ${node.color}">${mark}</span><span><b>${escapeHtml(PIECE_NAMES[node.type] || node.type)}</b><small>${node.color === 'white' ? 'White' : 'Black'} piece</small>${powers}</span></div>${(node.captures || []).length ? renderCaptureTree(node.captures) : ''}</li>`;
  }).join('')}</ul>`;
}

function renderCoordinates() {
  const perspective = boardPerspective();
  const ranks = perspective === 'black' ? [1,2,3,4,5,6,7,8] : [8,7,6,5,4,3,2,1];
  const files = perspective === 'black' ? 'hgfedcba'.split('') : 'abcdefgh'.split('');
  $('rankCoordinates').innerHTML = ranks.map((rank) => `<span>${rank}</span>`).join('');
  $('fileCoordinates').innerHTML = files.map((file) => `<span>${file}</span>`).join('');
}

function findKing(state, color) {
  for (let y=0;y<8;y++) for (let x=0;x<8;x++) {
    const piece = state.board[y][x];
    if (piece?.color === color && piece.type === 'king') return { x, y };
  }
  return null;
}

function onSquareClick(x, y) {
  if (!gameState || gameMode === 'replay' || gameMode === 'aiwatch' || (gameMode === 'online' && !players.black)) return;
  const allowedColor = gameMode === 'local' ? gameState.turn : myColor;
  const canMoveNow = !gameState.gameOver && gameState.turn === allowedColor;
  const clicked = gameState.board[y][x];
  if (selected) {
    const move = legalMoves.find((candidate) => candidate.x === x && candidate.y === y);
    if (move && canMoveNow) {
      const movingPiece = gameState.board[selected.y][selected.x];
      if (movingPiece.type === 'pawn' && (y === 0 || y === 7)) {
        pendingPromotion = { from: selected, to: { x, y } };
        $('promotionModal').classList.remove('hidden');
        return;
      }
      emitMove(selected, { x, y });
      selected = null;
      legalMoves = [];
      renderBoard();
      return;
    }
    if (clicked) {
      choosePiece(x, y); // Selecting an inactive/opponent piece is inspection-only.
      return;
    }
    selected = null;
    legalMoves = [];
    renderBoard();
    renderPieceDetail(null);
    return;
  }
  if (clicked) choosePiece(x, y);
}

function choosePiece(x, y) {
  const piece = gameState.board[y][x];
  selected = { x, y };
  const allowedColor = gameMode === 'local' ? gameState.turn : myColor;
  legalMoves = !gameState.gameOver && piece?.color === allowedColor && gameState.turn === allowedColor
    ? getLegalMoves(gameState, x, y)
    : [];
  renderBoard();
  renderPieceDetail(piece);
}

function handlePromotion(type) {
  if (!pendingPromotion) return;
  emitMove(pendingPromotion.from, pendingPromotion.to, type);
  pendingPromotion = null;
  $('promotionModal').classList.add('hidden');
  selected = null;
  legalMoves = [];
  renderBoard();
}

function renderPieceDetail(piece) {
  $('pieceDetailEmpty').classList.toggle('hidden', Boolean(piece));
  $('pieceDetail').classList.toggle('hidden', !piece);
  if (!piece) return;
  const capabilities = pieceCapabilities(piece);
  const powers = capabilities.length
    ? `<div class="power-pills">${capabilities.map((type) => `<span class="power-pill">${tinyGlyphs[type] || '✦'} ${PIECE_NAMES[type].toUpperCase()}</span>`).join('')}</div>`
    : '<div class="power-empty">No additional movement capabilities.</div>';
  const owner = gameMode === 'local'
    ? `${piece.color === 'white' ? 'White' : 'Black'} player’s`
    : (piece.color === myColor ? 'Your' : 'Opponent’s');
  const captures = piece.captures || [];
  const captureCount = captureTreeCount(captures);
  const tree = `<details class="capture-tree-disclosure"><summary>VIEW CAPTURE HISTORY <span>${captureCount} ${captureCount === 1 ? 'PIECE' : 'PIECES'}</span></summary><div class="capture-tree"><div class="capture-tree-root"><span>${glyphs[piece.color][piece.type]}</span><b>${PIECE_NAMES[piece.type]} · THIS PIECE</b></div>${renderCaptureTree(captures)}</div></details>`;
  $('pieceDetail').innerHTML = `<div class="detail-piece-glyph">${glyphs[piece.color][piece.type]}</div><div class="detail-piece-info"><strong>${owner} ${PIECE_NAMES[piece.type]}</strong><small>${piece.color.toUpperCase()} · ${piece.id.toUpperCase()} · ${capabilities.length} ADDITIONAL CAPABILITIES</small>${powers}${tree}</div>`;
}

function renderPlayers() {
  if (gameMode === 'local') {
    const bottomColor = localOrientation === 'rotate' ? gameState.turn : 'white';
    const topColor = bottomColor === 'white' ? 'black' : 'white';
    const bottom = players[bottomColor];
    const top = players[topColor];
    $('selfName').textContent = bottom?.name || (bottomColor === 'white' ? 'White' : 'Black');
    $('selfMeta').textContent = `${bottomColor.toUpperCase()} · ${bottomColor === gameState.turn ? 'TO MOVE' : 'LOCAL PLAYER'} · ${gameState.captured?.[bottomColor]?.length || 0} CAPTURES`;
    $('selfAvatar').textContent = glyphs[bottomColor].king;
    $('selfAvatar').className = `player-avatar ${bottomColor === 'white' ? 'white-avatar' : 'black-avatar'}`;
    $('opponentName').textContent = top?.name || (topColor === 'white' ? 'White' : 'Black');
    $('opponentMeta').textContent = `${topColor.toUpperCase()} · ${topColor === gameState.turn ? 'TO MOVE' : 'LOCAL PLAYER'} · ${gameState.captured?.[topColor]?.length || 0} CAPTURES`;
    $('opponentAvatar').textContent = glyphs[topColor].king;
    $('opponentAvatar').className = `player-avatar ${topColor === 'white' ? 'white-avatar' : 'black-avatar'}`;
    $('opponentPresence').classList.add('online');
    $('opponentPresence').classList.remove('offline');
    $('selfStrip').querySelector('.you-tag').textContent = bottomColor === gameState.turn ? 'TO MOVE' : 'BOTTOM';
    return;
  }
  $('selfStrip').querySelector('.you-tag').textContent = ['aiwatch', 'replay'].includes(gameMode) ? (gameMode === 'replay' ? 'REPLAY' : 'WATCHING') : 'YOU';

  if (gameMode === 'aiwatch' || gameMode === 'replay') {
    $('selfName').textContent = players.white?.name || (gameMode === 'replay' ? 'White' : 'Evolution AI');
    $('selfMeta').textContent = `WHITE · ${gameMode === 'replay' ? 'SAVED GAME' : 'AI'} · ${gameState.captured?.white?.length || 0} CAPTURES`;
    $('selfAvatar').textContent = glyphs.white.king;
    $('selfAvatar').className = 'player-avatar white-avatar';
    $('opponentName').textContent = players.black?.name || (gameMode === 'replay' ? 'Black' : 'Evolution AI');
    $('opponentMeta').textContent = `BLACK · ${gameMode === 'replay' ? 'SAVED GAME' : 'AI'} · ${gameState.captured?.black?.length || 0} CAPTURES`;
    $('opponentAvatar').textContent = glyphs.black.king;
    $('opponentAvatar').className = 'player-avatar black-avatar';
    $('opponentPresence').classList.add('online');
    $('opponentPresence').classList.remove('offline');
    return;
  }

  const isComputer = gameMode === 'computer';
  const opponentColor = myColor === 'white' ? 'black' : 'white';
  const me = players[myColor];
  const opponent = players[opponentColor];
  $('selfName').textContent = me?.name || 'You';
  $('selfMeta').textContent = `${myColor.toUpperCase()} · YOU · ${gameState.captured?.[myColor]?.length || 0} CAPTURES`;
  $('selfAvatar').textContent = glyphs[myColor].king;
  $('selfAvatar').className = `player-avatar ${myColor === 'white' ? 'white-avatar' : 'black-avatar'}`;
  $('opponentName').textContent = opponent?.name || 'Waiting for opponent';
  $('opponentMeta').textContent = `${opponentColor.toUpperCase()} · ${isComputer ? 'COMPUTER' : (presence[opponentColor] ? 'CONNECTED' : 'NOT CONNECTED')} · ${gameState.captured?.[opponentColor]?.length || 0} CAPTURES`;
  $('opponentAvatar').textContent = glyphs[opponentColor].king;
  $('opponentAvatar').className = `player-avatar ${opponentColor === 'white' ? 'white-avatar' : 'black-avatar'}`;
  $('opponentPresence').classList.toggle('online', isComputer || Boolean(presence[opponentColor]));
  $('opponentPresence').classList.toggle('offline', !isComputer && !presence[opponentColor]);
}

function renderStatus() {
  const isLocal = gameMode === 'local';
  const isComputer = gameMode === 'computer';
  const isAiWatch = gameMode === 'aiwatch';
  const isReplay = gameMode === 'replay';
  const yourTurn = gameState.turn === myColor;
  const activeName = gameState.turn === 'white' ? 'White' : 'Black';
  const headline = $('turnHeadline');
  const label = $('turnLabel');
  const icon = $('turnIcon');
  const subline = $('statusSubline');
  const isWaiting = !isLocal && !isComputer && !isAiWatch && !isReplay && !players.black;
  const checkmate = gameState.status === 'checkmate';
  const stalemate = gameState.status === 'stalemate';
  const drawn = gameState.gameOver && !gameState.winner;
  icon.textContent = glyphs[gameState.turn].king;
  icon.className = `turn-icon ${gameState.turn === 'white' ? 'white-turn' : 'black-turn'}`;
  $('newGameBtn').classList.toggle('hidden', !gameState.gameOver || isReplay);

  if (isReplay) {
    label.textContent = gameState.gameOver ? 'REPLAY COMPLETE' : `REPLAY · ${gameState.turn.toUpperCase()} TO MOVE`;
    headline.textContent = gameState.gameOver
      ? (gameState.winner ? `${players[gameState.winner]?.name || (gameState.winner === 'white' ? 'White' : 'Black')} won.` : 'A drawn match.')
      : `Move ${replayIndex} of ${replayRecord?.moves?.length || 0}`;
    subline.textContent = replayPlaying ? 'Playing back the saved match timeline.' : 'Replay paused. Step through moves or resume playback.';
  } else if (isWaiting) {
    label.textContent = 'ROOM OPEN';
    headline.textContent = 'Waiting for player…';
    subline.textContent = `Share room ${roomCode} with a friend to begin.`;
  } else if (isAiWatch && !checkmate && !stalemate && !gameState.gameOver) {
    label.textContent = `${gameState.turn.toUpperCase()} AI TO MOVE`;
    headline.textContent = `${gameState.turn === 'white' ? players.white?.name : players.black?.name} thinking…`;
    subline.textContent = aiThinking ? 'The AI is calculating the next move.' : 'The next move will play automatically.';
  } else if (checkmate) {
    label.textContent = 'CHECKMATE';
    headline.textContent = isLocal ? `${gameState.winner === 'white' ? 'White' : 'Black'} wins.` : (gameState.winner === myColor ? 'You won.' : (isComputer ? 'Evolution AI wins.' : (isAiWatch ? `${players[gameState.winner]?.name || 'AI'} wins.` : 'You were defeated.')));
    subline.textContent = 'The king has no safe escape. The match is complete.';
  } else if (drawn) {
    label.textContent = gameState.status === 'threefold-repetition' ? 'THREEFOLD REPETITION' : (gameState.status === 'fifty-move-rule' ? '50-MOVE RULE' : 'STALEMATE');
    headline.textContent = 'A drawn match.';
    subline.textContent = gameState.status === 'threefold-repetition'
      ? 'The same full position appeared three times.'
      : (gameState.status === 'fifty-move-rule' ? '100 half-moves passed without a pawn move or capture.' : 'No legal moves remain, but the king is not in check.');
  } else if (gameState.check) {
    label.textContent = `${gameState.check.toUpperCase()} KING IN CHECK`;
    headline.textContent = isLocal ? `${gameState.check === 'white' ? 'White' : 'Black'} king is under attack.` : (gameState.check === myColor ? 'Your king is under attack.' : (isComputer ? 'Evolution AI is in check.' : 'Opponent is in check.'));
    subline.textContent = 'Find a legal escape before the next move.';
  } else {
    label.textContent = `${gameState.turn.toUpperCase()} TO MOVE`;
    headline.textContent = isLocal ? `${activeName} to move.` : (yourTurn ? 'Your move.' : (isComputer ? (aiThinking ? 'Thinking…' : 'Evolution AI to move.') : 'Opponent’s turn.'));
    subline.textContent = isLocal
      ? (localOrientation === 'rotate' ? `${activeName} to play. The board rotates toward the next player.` : `${activeName} to play. The board stays fixed with White at the bottom.`)
      : (isComputer ? (yourTurn ? 'Capture to evolve your pieces.' : (aiThinking ? 'The computer is calculating its response.' : 'The computer is preparing a move.')) : (yourTurn ? 'Capture to evolve your pieces.' : 'Watch their pieces. Every capture matters.'));
  }

  const last = gameState.history.at(-1);
  if (!isReplay && !gameState.gameOver && last?.inherited?.length) {
    const names = [...new Set(last.inherited)].map((type) => PIECE_NAMES[type]).join(', ');
    const playerLabel = isLocal ? (last.color === 'white' ? 'White' : 'Black') : (isAiWatch ? (last.color === 'white' ? players.white?.name || 'White AI' : players.black?.name || 'Black AI') : (last.color === myColor ? 'You' : (isComputer ? 'Evolution AI' : 'Opponent')));
    subline.textContent = `${playerLabel} inherited ${names} power${last.inherited.length > 1 ? 's' : ''}.`;
  }
  if (isWaiting) $('newGameBtn').classList.add('hidden');
}

function renderHistory() {
  const history = gameState.history || [];
  $('moveCount').textContent = String(history.length).padStart(2, '0');
  if (!history.length) {
    $('moveHistory').innerHTML = '<div class="history-empty">The first move is yours to make.</div>';
    return;
  }
  $('moveHistory').innerHTML = [...history].reverse().map((move) => {
    const powers = move.inherited?.length
      ? `<small>✦ inherited ${move.inherited.map((power) => PIECE_NAMES[power]).join(' + ')}</small>` : '';
    return `<div class="history-row"><span class="history-num">${String(move.number).padStart(2,'0')}</span><span class="history-desc">${escapeHtml(move.notation)}${powers}</span></div>`;
  }).join('');
}

function renderMatchStats() {
  const panel = $('matchStats');
  if (!gameState?.gameOver) {
    panel.classList.add('hidden');
    panel.innerHTML = '';
    return;
  }
  const history = gameState.history || [];
  const summarize = (color) => {
    const moves = history.filter((move) => move.color === color);
    const captures = moves.filter((move) => Boolean(move.capturedType)).length;
    const abilities = moves.reduce((sum, move) => sum + (move.inherited || []).length, 0);
    const promotions = moves.filter((move) => Boolean(move.promotion)).length;
    const pieces = gameState.board.flat().filter((piece) => piece?.color === color);
    const mostEvolved = pieces.reduce((best, piece) => {
      const value = new Set([piece.type, ...(piece.powers || [])]).size;
      return !best || value > best.value ? { piece, value } : best;
    }, null);
    return { moves: moves.length, captures, abilities, promotions, mostEvolved };
  };
  const white = summarize('white');
  const black = summarize('black');
  const result = gameState.winner
    ? `${gameState.winner === 'white' ? (players.white?.name || 'White') : (players.black?.name || 'Black')} won`
    : 'Draw';
  const statColumn = (color, data) => `<div class="stats-player"><b>${color === 'white' ? 'WHITE' : 'BLACK'} · ${escapeHtml(players[color]?.name || (color === 'white' ? 'White' : 'Black'))}</b><span>${data.moves} moves</span><span>${data.captures} captures</span><span>${data.abilities} new abilities</span><span>${data.promotions} promotions</span><small>${data.mostEvolved ? `Most evolved: ${PIECE_NAMES[data.mostEvolved.piece.type]} (${data.mostEvolved.value} capabilities)` : 'No surviving pieces'}</small></div>`;
  panel.innerHTML = `<div class="stats-heading"><b>MATCH STATISTICS</b><strong>${escapeHtml(result)}</strong></div><div class="stats-total"><span>${history.length} total plies</span><span>${gameState.status === 'checkmate' ? 'Checkmate' : (gameState.status === 'threefold-repetition' ? 'Threefold repetition' : (gameState.status === 'fifty-move-rule' ? '50-move rule' : 'Stalemate'))}</span></div><div class="stats-columns">${statColumn('white', white)}${statColumn('black', black)}</div>`;
  // Statistics are deliberately opened from the match-end dialog, not
  // permanently exposed in the sidebar underneath the board.
  panel.classList.add('hidden');
}

function showMatchEndDialog() {
  if (gameMode === 'replay' || !gameState?.gameOver || endPopupShown) return;

  const modal = $('matchEndModal');
  const winnerColor = gameState.winner;
  const winner = winnerColor ? (players[winnerColor]?.name || (winnerColor === 'white' ? 'White' : 'Black')) : null;
  const drawMessages = {
    stalemate: 'No legal moves remain, but the king is not in check.',
    'threefold-repetition': 'The same position occurred three times. The match is drawn.',
    'fifty-move-rule': '100 half-moves passed without a pawn move or capture. The match is drawn.'
  };
  const terminalLabel = gameState.status === 'checkmate' ? 'CHECKMATE' : (gameState.status === 'stalemate' ? 'STALEMATE' : 'DRAW');
  $('matchEndEyebrow').textContent = terminalLabel;
  $('matchEndTitle').textContent = winner ? `${winner} wins!` : 'The match is a draw';
  $('matchEndMessage').textContent = gameState.status === 'checkmate'
    ? `${winner || 'The winner'} delivered checkmate. The king has no legal escape.`
    : (drawMessages[gameState.status] || 'The match ended in a draw.');
  $('endStatisticsContent').innerHTML = $('matchStats').innerHTML;
  $('saveMatchBtn').textContent = currentMatchSavedId ? 'SAVED TO ARCHIVE' : 'SAVE MATCH';
  $('saveMatchBtn').disabled = Boolean(currentMatchSavedId);
  $('endAnnouncementView').classList.remove('hidden');
  $('endStatisticsView').classList.add('hidden');

  // Native <dialog> is rendered in the browser top layer, avoiding the
  // stacking/visibility problems that affected the old div-based popup.
  endPopupShown = true;
  if (typeof modal.showModal === 'function') {
    if (!modal.open) modal.showModal();
  } else {
    modal.setAttribute('open', '');
  }
}

function closeMatchEndDialog() {
  const modal = $('matchEndModal');
  if (!modal) return;
  if (typeof modal.close === 'function' && modal.open) modal.close();
  else modal.removeAttribute('open');
}

function openEndStatistics() {
  $('endStatisticsContent').innerHTML = $('matchStats').innerHTML;
  $('endAnnouncementView').classList.add('hidden');
  $('endStatisticsView').classList.remove('hidden');
}

function backToEndAnnouncement() {
  $('endStatisticsView').classList.add('hidden');
  $('endAnnouncementView').classList.remove('hidden');
}

function updateVisualStyleControls() {
  const visualSelect = $('visualStyleSelect');
  if (visualSelect) visualSelect.value = visualStyle;
  const orientationControl = $('orientationControl');
  const orientationSelect = $('orientationSelect');
  if (orientationControl) orientationControl.classList.toggle('hidden', gameMode !== 'local');
  if (orientationSelect) orientationSelect.value = localOrientation;
}

function renderGame() {
  if (!gameState || !myColor) return;
  renderPlayers();
  renderBoard();
  renderStatus();
  renderHistory();
  renderMatchStats();
  updateVisualStyleControls();
  renderReplayControls();
  showMatchEndDialog();
  if (selected) renderPieceDetail(gameState.board[selected.y][selected.x]);
}

function buildSavedMatchRecord() {
  if (!gameState?.gameOver) throw new Error('Only completed matches can be saved.');
  const startedAt = Number(initialGameState?.startedAt || gameState.startedAt || Date.now());
  const moves = cloneData(gameState.history || []);
  const endedAt = Number(moves.at(-1)?.playedAt || Date.now());
  const modeLabels = { online: 'Online multiplayer', local: 'Local pass-and-play', computer: 'Vs Evolution AI', aiwatch: 'AI vs AI' };
  return {
    schemaVersion: 1,
    id: globalThis.crypto?.randomUUID ? crypto.randomUUID() : `game_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    createdAt: Date.now(),
    startedAt,
    endedAt,
    durationMs: Math.max(0, endedAt - startedAt),
    mode: gameMode,
    modeLabel: modeLabels[gameMode] || 'Chess Evolution match',
    status: gameState.status,
    winner: gameState.winner || null,
    players: cloneData(players),
    moveCount: moves.length,
    initialState: cloneData(initialGameState || createInitialState()),
    moves,
    syncStatus: 'pending'
  };
}

async function saveCurrentMatch() {
  const button = $('saveMatchBtn');
  if (!gameState?.gameOver || currentMatchSavedId) return;
  button.disabled = true;
  button.textContent = 'SAVING…';
  try {
    const record = buildSavedMatchRecord();
    await putSavedGame(record);
    currentMatchSavedId = record.id;
    button.textContent = 'SAVED TO ARCHIVE';
    button.disabled = true;
    toast('Match saved on this device. Cloud sync will happen when available.');
    refreshSavedGamesList();
    syncSavedGames({ quiet: true });
  } catch (error) {
    button.disabled = false;
    button.textContent = 'SAVE MATCH';
    toast(error instanceof Error ? error.message : 'The match could not be saved.');
  }
}

function getMatchResultLabel(game) {
  if (game.winner) return `${game.players?.[game.winner]?.name || (game.winner === 'white' ? 'White' : 'Black')} won`;
  if (game.status === 'threefold-repetition') return 'Draw · repetition';
  if (game.status === 'fifty-move-rule') return 'Draw · 50-move rule';
  return 'Draw · stalemate';
}

async function refreshSavedGamesList() {
  const list = $('savedGamesList');
  if (!list) return;
  try {
    const games = await listSavedGames();
    $('savedGamesCount').textContent = `${games.length} ${games.length === 1 ? 'GAME' : 'GAMES'}`;
    if (!games.length) {
      list.innerHTML = '<div class="saved-games-empty">No saved games yet. Save a completed match to see it here.</div>';
      return;
    }
    list.innerHTML = games.map((game) => {
      const date = new Date(Number(game.createdAt) || Date.now()).toLocaleString();
      const white = game.players?.white?.name || 'White';
      const black = game.players?.black?.name || 'Black';
      const syncLabel = game.syncStatus === 'synced' ? 'SERVER COPY UPLOADED' : 'ON THIS DEVICE · WAITING TO SYNC';
      return `<article class="saved-game-item" data-game-id="${escapeHtml(game.id)}">
        <div class="saved-game-main"><div class="saved-game-result">${escapeHtml(getMatchResultLabel(game))}</div><div class="saved-game-players">${escapeHtml(white)} <span>vs</span> ${escapeHtml(black)}</div><div class="saved-game-meta">${escapeHtml(game.modeLabel || 'Chess Evolution match')} · ${Number(game.moveCount ?? game.moves?.length ?? 0)} plies · ${escapeHtml(date)}</div><div class="saved-game-sync ${game.syncStatus === 'synced' ? 'is-synced' : ''}">${syncLabel}</div></div>
        <div class="saved-game-actions"><button type="button" data-watch-game="${escapeHtml(game.id)}" class="saved-watch-button">WATCH REPLAY</button><button type="button" data-delete-game="${escapeHtml(game.id)}" class="saved-delete-button" aria-label="Delete saved game">DELETE</button></div>
      </article>`;
    }).join('');
    list.querySelectorAll('[data-watch-game]').forEach((button) => button.addEventListener('click', async () => {
      const game = (await listSavedGames()).find((entry) => entry.id === button.dataset.watchGame);
      if (game) openSavedGame(game);
    }));
    list.querySelectorAll('[data-delete-game]').forEach((button) => button.addEventListener('click', () => deleteSavedGame(button.dataset.deleteGame)));
  } catch (error) {
    list.innerHTML = `<div class="saved-games-empty">Could not load saved games: ${escapeHtml(error instanceof Error ? error.message : 'storage error')}</div>`;
  }
}

async function syncSavedGames({ quiet = false } = {}) {
  const status = $('archiveSyncStatus');
  if (!navigator.onLine) {
    if (status) status.textContent = 'Offline: saved matches are stored on this device and will sync when you reconnect.';
    return false;
  }
  try {
    const libraryKey = getArchiveKey();
    // Apply queued deletions before downloading the cloud list again.
    for (const id of getDeletedGameIds()) {
      const response = await fetch(`/api/saved-games/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { 'x-archive-key': libraryKey } });
      if (response.ok) forgetDeletedGame(id);
    }

    const response = await fetch('/api/saved-games', { cache: 'no-store', headers: { 'x-archive-key': libraryKey } });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || `Cloud archive unavailable (${response.status}).`);
    }
    const remote = await response.json();
    const remoteGames = Array.isArray(remote.games) ? remote.games : [];
    const remoteIds = new Set(remoteGames.map((game) => game.id));
    await putSavedGames(remoteGames.map((game) => ({ ...game, syncStatus: 'synced' })));

    // Render app copies missing from a server-side ephemeral filesystem as pending
    // again, so the device that still has them can restore the cloud archive.
    let local = await listSavedGames();
    for (const game of local) {
      if (game.syncStatus === 'synced' && !remoteIds.has(game.id)) {
        await putSavedGame({ ...game, syncStatus: 'pending' });
      }
    }
    local = await listSavedGames();
    const pending = local.filter((game) => game.syncStatus !== 'synced');
    let uploaded = 0;
    for (let offset = 0; offset < pending.length; offset += 8) {
      const batch = pending.slice(offset, offset + 8);
      const upload = await fetch('/api/saved-games/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-archive-key': libraryKey },
        body: JSON.stringify({ games: batch })
      });
      if (!upload.ok) {
        const result = await upload.json().catch(() => ({}));
        throw new Error(result.error || `Cloud upload failed (${upload.status}).`);
      }
      const stored = new Set((await upload.json()).stored || []);
      for (const game of batch) {
        if (stored.has(game.id)) {
          await putSavedGame({ ...game, syncStatus: 'synced', syncedAt: Date.now() });
          uploaded += 1;
        }
      }
    }
    if (status) status.textContent = `Server archive upload complete · ${remoteGames.length + uploaded} game${remoteGames.length + uploaded === 1 ? '' : 's'} available in this archive.`;
    if (activeScreen === 'saved') refreshSavedGamesList();
    return true;
  } catch (error) {
    if (status) status.textContent = `Saved on this device. Server upload will retry: ${error instanceof Error ? error.message : 'server unavailable'}`;
    if (!quiet) toast('Your games are still stored on this device; server upload could not complete.');
    return false;
  }
}

async function deleteSavedGame(id) {
  if (!id || !confirm('Delete this saved match from your archive?')) return;
  rememberDeletedGame(id);
  await removeSavedGame(id);
  refreshSavedGamesList();
  if (navigator.onLine) syncSavedGames({ quiet: true });
}

async function exportSavedGamesBackup() {
  try {
    const games = await listSavedGames();
    const backup = { format: 'chess-evolution-saved-games', version: 1, exportedAt: new Date().toISOString(), games };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `chess-evolution-saved-games-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    toast(`${games.length} saved games exported.`);
  } catch (error) {
    toast(error instanceof Error ? error.message : 'Could not export the archive.');
  }
}

async function importSavedGamesBackup(file) {
  if (!file) return;
  try {
    if (file.size > 20 * 1024 * 1024) throw new Error('Backup is larger than 20 MB.');
    const data = JSON.parse(await file.text());
    const games = Array.isArray(data) ? data : data.games;
    if (!Array.isArray(games)) throw new Error('This file is not a Chess Evolution saved-games backup.');
    const valid = games.filter((game) => game && typeof game.id === 'string' && Array.isArray(game.moves) && game.initialState?.board?.length === 8)
      .map((game) => ({ ...game, syncStatus: 'pending' }));
    if (!valid.length) throw new Error('No valid saved games were found in that backup.');
    await putSavedGames(valid);
    toast(`${valid.length} saved game${valid.length === 1 ? '' : 's'} imported.`);
    await syncSavedGames({ quiet: true });
    await refreshSavedGamesList();
  } catch (error) {
    toast(error instanceof Error ? error.message : 'The backup could not be imported.');
  } finally {
    $('importSavedGamesInput').value = '';
  }
}

function openSavedGames() {
  if (activeScreen !== 'saved') savedGamesReturnScreen = gameMode === 'replay' ? 'saved' : activeScreen;
  if (gameMode === 'replay') pauseReplay();
  try { $('archiveKeyInput').value = getArchiveKey(); } catch (error) { $('archiveSyncStatus').textContent = error.message; }
  setScreen('saved');
  refreshSavedGamesList();
  syncSavedGames({ quiet: true });
}

function returnFromSavedGames() {
  const target = savedGamesReturnScreen || 'lobby';
  setScreen(target);
  if (target === 'game') {
    renderGame();
    if (gameMode === 'online' && roomCode && socket?.connected) {
      socket.emit('join-room', { code: roomCode, playerId, name: getPlayerName(), reconnect: true });
    } else if (gameMode === 'computer' && gameState && !gameState.gameOver && gameState.turn !== myColor) {
      requestComputerMove();
    } else if (gameMode === 'aiwatch' && gameState && !gameState.gameOver) {
      requestAiWatchMove();
    }
  }
}

function renderReplayControls() {
  const card = $('replayControlsCard');
  if (!card) return;
  const isReplay = gameMode === 'replay' && Boolean(replayRecord);
  card.classList.toggle('hidden', !isReplay);
  if (!isReplay) return;
  const total = replayRecord.moves?.length || 0;
  const lastPlayedAt = replayIndex > 0 ? Number(replayRecord.moves[replayIndex - 1]?.playedAt) : Number(replayRecord.startedAt);
  const elapsed = Number.isFinite(lastPlayedAt) ? Math.max(0, lastPlayedAt - Number(replayRecord.startedAt || lastPlayedAt)) : 0;
  $('replayProgressText').textContent = `MOVE ${replayIndex} / ${total} · ${formatElapsed(elapsed)}`;
  $('replayPlayPauseBtn').textContent = replayPlaying ? 'PAUSE' : (replayIndex >= total ? 'PLAY AGAIN' : 'PLAY');
  $('replayPreviousBtn').disabled = replayIndex <= 0;
  $('replayNextBtn').disabled = replayIndex >= total;
  $('replayTimingHint').textContent = replaySpeed === 'original'
    ? 'Using the exact recorded wait between each move. Long thinking pauses are preserved.'
    : `Playing at ${replaySpeed}× the original speed.`;
}

function setReplayPosition(moveCount) {
  if (!replayRecord) return;
  pauseReplay();
  gameState = cloneData(replayRecord.initialState);
  gameState.history = [];
  if (!gameState.positionCounts) {
    gameState.positionCounts = {};
  }
  const initialKey = Object.keys(gameState.positionCounts)[0];
  if (!initialKey) {
    // Saved archives made by this version include the complete initial rules state.
    // If a legacy export omits repetition bookkeeping, the engine seeds it on its first move.
  }
  const target = Math.max(0, Math.min(replayRecord.moves.length, Number(moveCount) || 0));
  for (const savedMove of replayRecord.moves.slice(0, target)) {
    const from = squareToCoords(savedMove.from);
    const to = squareToCoords(savedMove.to);
    if (!from || !to) throw new Error(`Invalid move in saved game: ${savedMove.notation || savedMove.from}`);
    playMove(gameState, from, to, savedMove.promotion || 'queen');
  }
  replayIndex = target;
  selected = null;
  legalMoves = [];
  renderGame();
}

function applyNextReplayMove() {
  if (!replayRecord || replayIndex >= replayRecord.moves.length) {
    pauseReplay();
    return;
  }
  const savedMove = replayRecord.moves[replayIndex];
  const from = squareToCoords(savedMove.from);
  const to = squareToCoords(savedMove.to);
  if (!from || !to) {
    pauseReplay();
    toast('This saved game contains an invalid move and cannot continue replaying.');
    return;
  }
  try {
    playMove(gameState, from, to, savedMove.promotion || 'queen');
    replayIndex += 1;
    renderGame();
  } catch (error) {
    pauseReplay();
    toast(`Replay stopped: ${error instanceof Error ? error.message : 'invalid move'}`);
    return;
  }
  if (replayIndex >= replayRecord.moves.length || gameState.gameOver) pauseReplay();
  else if (replayPlaying) scheduleReplayMove();
}

function scheduleReplayMove() {
  clearReplayTimer();
  if (!replayPlaying || !replayRecord || replayIndex >= replayRecord.moves.length) return;
  const delay = scaledMoveDelay(replayRecord.moves, replayIndex, replayRecord.startedAt, replaySpeed);
  replayTimer = setTimeout(() => {
    replayTimer = null;
    applyNextReplayMove();
  }, delay);
}

function startReplayPlayback() {
  if (!replayRecord) return;
  if (replayIndex >= replayRecord.moves.length) setReplayPosition(0);
  replayPlaying = true;
  renderReplayControls();
  renderStatus();
  scheduleReplayMove();
}

function openSavedGame(game) {
  if (!game || !Array.isArray(game.moves) || !game.initialState?.board) return;
  pauseReplay();
  if (gameMode === 'computer' || gameMode === 'aiwatch') invalidateAiSearch();
  closeMatchEndDialog();
  if (gameMode !== 'replay') {
    replayReturnContext = {
      gameMode, roomCode, myColor, gameState, initialGameState, players, presence,
      selected, legalMoves, endPopupShown
    };
  }
  replayRecord = cloneData(game);
  replayIndex = 0;
  replaySpeed = 'original';
  $('replaySpeedSelect').value = 'original';
  gameMode = 'replay';
  roomCode = null;
  myColor = 'white';
  gameState = cloneData(replayRecord.initialState);
  players = cloneData(replayRecord.players || { white: { name: 'White' }, black: { name: 'Black' } });
  presence = { white: true, black: true };
  selected = null;
  legalMoves = [];
  endPopupShown = false;
  $('roomCodeLabel').textContent = 'SAVED';
  $('roomChipLabel').textContent = 'REPLAY';
  $('matchModeLabel').textContent = 'SAVED GAME REPLAY';
  $('copyRoomBtn').classList.add('hidden');
  $('leaveRoomBtn').textContent = 'BACK TO SAVED GAMES';
  setConnection(false, 'REPLAY MODE');
  setScreen('game');
  renderGame();
  startReplayPlayback();
}

function exitSavedGameReplay() {
  pauseReplay();
  const context = replayReturnContext;
  replayReturnContext = null;
  replayRecord = null;
  replayIndex = 0;
  if (context) {
    gameMode = context.gameMode;
    roomCode = context.roomCode;
    myColor = context.myColor;
    gameState = context.gameState;
    initialGameState = context.initialGameState;
    players = context.players;
    presence = context.presence;
    selected = context.selected;
    legalMoves = context.legalMoves;
    endPopupShown = context.endPopupShown;
  } else {
    gameMode = 'online';
    roomCode = null;
    myColor = null;
    gameState = null;
    initialGameState = null;
    players = { white: null, black: null };
    presence = { white: false, black: false };
  }
  $('leaveRoomBtn').textContent = 'LEAVE MATCH';
  $('copyRoomBtn').classList.toggle('hidden', gameMode !== 'online' || !roomCode);
  setScreen('saved');
  refreshSavedGamesList();
  if (gameState && activeScreen === 'game') renderGame();
  setConnection(gameMode === 'online' ? Boolean(socket?.connected) : false, gameMode === 'online' ? (socket?.connected ? 'CONNECTED' : 'SERVER OFFLINE') : `${gameMode.toUpperCase()} MODE`);
}

function updatePresence(payload) {
  if (!payload || payload.code !== roomCode) return;
  players = payload.players || players;
  presence = payload.presence || presence;
  renderPlayers();
  renderStatus();
}

function renderTrainingStatus(status) {
  const phase = $('trainingPhase');
  if (!phase) return;
  const active = Boolean(status?.running);
  const phaseLabels = {
    idle: 'READY', 'self-play': 'GENERATING SELF-PLAY DATA',
    training: 'TRAINING EVALUATION WEIGHTS', stopping: 'STOPPING AFTER CURRENT GAMES',
    complete: 'GENERATION COMPLETE', error: 'TRAINING ERROR'
  };
  phase.textContent = status?.enabled === false ? 'SET TRAINING_API_KEY ON THE SERVER' : (phaseLabels[status?.phase] || 'READY');
  $('trainingProgressFill').style.width = `${Math.max(0, Math.min(100, Number(status?.progress) || 0))}%`;
  $('trainingProgressText').textContent = status?.phase === 'training'
    ? 'Dataset collected · fitting model weights…'
    : `${status?.gamesCompleted || 0} / ${status?.games || 0} games · ${status?.progress || 0}%`;
  $('trainingGeneration').textContent = String(status?.modelGeneration ?? status?.generation ?? 0).padStart(3, '0');
  $('trainingPositions').textContent = Number(status?.positionsCollected || 0).toLocaleString();
  $('trainingCaptures').textContent = Number(status?.captures || 0).toLocaleString();
  $('trainingEvolutionEvents').textContent = Number(status?.inheritedAbilities || 0).toLocaleString();
  $('trainingResults').textContent = `${status?.whiteWins || 0}W · ${status?.draws || 0}D · ${status?.blackWins || 0}B`;
  $('startTrainingBtn').disabled = active || status?.enabled === false;
  $('stopTrainingBtn').classList.toggle('hidden', !active);
  $('trainingError').textContent = status?.error || '';
  $('trainingOutput').textContent = status?.outputDirectory ? `SAVED: ${status.outputDirectory}` : '';
  if (status?.metrics) {
    const baseline = status.metrics.baselineValidationLoss;
    const validation = status.metrics.validationLoss;
    const change = status.metrics.validationImproved ? 'validation loss improved' : 'validation loss not improved yet';
    $('trainingMetrics').textContent = `Training positions ${Number(status.metrics.trainingSamples).toLocaleString()} · validation ${Number(status.metrics.validationSamples).toLocaleString()} · loss ${baseline} → ${validation} (${change})`;
  } else {
    $('trainingMetrics').textContent = 'Model: nine learned evaluation weights · awaiting first generation';
  }
  const weights = status?.weights || learnedEvaluationModel?.weights;
  if (weights) {
    $('trainingWeights').textContent = Object.entries(weights)
      .map(([name, value]) => `${name}: ${Number(value).toFixed(3)}`)
      .join('  ·  ');
  }
}

async function refreshTrainingStatus() {
  try {
    const [statusResponse, modelResponse] = await Promise.all([
      fetch('/api/training/status', { cache: 'no-store' }),
      fetch('/api/training/model', { cache: 'no-store' })
    ]);
    let currentStatus = null;
    if (statusResponse.ok) {
      currentStatus = await statusResponse.json();
      renderTrainingStatus(currentStatus);
    }
    if (modelResponse.ok) {
      const modelData = await modelResponse.json();
      if (modelData?.schemaVersion === 1) learnedEvaluationModel = modelData;
    }
    if (trainingPollTimer) clearTimeout(trainingPollTimer);
    // Poll continuously only while a generation is active. When idle or done,
    // keep the displayed status but avoid needless network requests.
    trainingPollTimer = currentStatus?.running
      ? setTimeout(refreshTrainingStatus, 1600)
      : null;
    return currentStatus;
  } catch {
    $('trainingPhase').textContent = 'LOCAL TRAINING API UNAVAILABLE';
    if (trainingPollTimer) clearTimeout(trainingPollTimer);
    trainingPollTimer = setTimeout(refreshTrainingStatus, 6000);
    return null;
  }
}

async function startTraining() {
  const button = $('startTrainingBtn');
  button.disabled = true;
  $('trainingError').textContent = '';
  try {
    const response = await fetch('/api/training/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...trainingAuthHeaders() },
      body: JSON.stringify({
        games: Number($('trainingGamesSelect').value) || 200,
        workers: Number($('trainingWorkersSelect').value) || 4,
        depth: Number($('trainingDepthSelect').value) || 2
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not start training.');
    renderTrainingStatus(result);
    toast(`Generation ${result.generation} started with ${result.workers} workers.`);
    refreshTrainingStatus();
  } catch (error) {
    button.disabled = false;
    $('trainingError').textContent = error instanceof Error ? error.message : 'Could not start training.';
  }
}

async function stopTraining() {
  try {
    const response = await fetch('/api/training/stop', { method: 'POST', headers: trainingAuthHeaders() });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not stop training.');
    renderTrainingStatus(result);
  } catch (error) {
    $('trainingError').textContent = error instanceof Error ? error.message : 'Could not stop training.';
  }
}

if (socket) {
  socket.on('connect', () => {
    setConnection(gameMode !== 'local', gameMode === 'local' ? 'LOCAL MODE' : 'CONNECTED');
    const saved = savedSession();
    if (gameMode !== 'replay' && saved?.code && saved.playerId === playerId && !roomCode) {
      socket.emit('join-room', { code: saved.code, playerId, name: saved.name || getPlayerName(), reconnect: true });
      showLobbyMessage('Reconnecting to your last match…');
    }
  });
  socket.on('disconnect', () => setConnection(false, gameMode === 'local' ? 'LOCAL MODE' : 'RECONNECTING'));
  socket.on('connect_error', () => {
    setConnection(false, 'SERVER OFFLINE');
    if (gameMode === 'online' && !$('lobbyScreen').classList.contains('hidden')) showLobbyMessage('Cannot reach the game server. Online play is unavailable; local play still works.', 'error');
  });
  socket.on('room-created', (payload) => {
    $('createRoomBtn').disabled = false;
    enterRoom(payload);
    toast(`Room ${payload.code} created. Share the code to invite a friend.`);
  });
  socket.on('room-joined', (payload) => {
    $('joinRoomBtn').disabled = false;
    enterRoom(payload);
    toast(`Joined room ${payload.code} as ${payload.color}.`);
  });
  socket.on('room-error', (message) => {
    if (!roomCode) clearSession();
    $('createRoomBtn').disabled = false;
    $('joinRoomBtn').disabled = false;
    showLobbyMessage(message, 'error');
    toast(message);
  });
  socket.on('game-state', (payload) => {
    if (gameMode === 'replay' && replayReturnContext?.roomCode && payload.code === replayReturnContext.roomCode) {
      replayReturnContext.gameState = payload.state;
      replayReturnContext.players = payload.players || replayReturnContext.players;
      replayReturnContext.presence = payload.presence || replayReturnContext.presence;
      return;
    }
    if (payload.code !== roomCode) return;
    const previousLength = gameState?.history?.length || 0;
    gameState = payload.state;
    players = payload.players || players;
    presence = payload.presence || presence;
    if ((gameState.history?.length || 0) > previousLength) {
      selected = null;
      legalMoves = [];
      const last = gameState.history.at(-1);
      if (last.color !== myColor) toast(`${players[last.color]?.name || 'Opponent'} played ${last.to}.`);
      if (last.inherited?.length && last.color === myColor) toast(`Power inherited: ${last.inherited.map((type) => PIECE_NAMES[type]).join(' + ')}`);
    }
    if (selected && !gameState.board[selected.y]?.[selected.x]) {
      selected = null;
      legalMoves = [];
    }
    renderGame();
  });
  socket.on('match-ended', (payload) => {
    if (gameMode === 'replay' && replayReturnContext?.roomCode && payload.code === replayReturnContext.roomCode) {
      replayReturnContext.gameState = payload.state;
      replayReturnContext.players = payload.players || replayReturnContext.players;
      replayReturnContext.presence = payload.presence || replayReturnContext.presence;
      replayReturnContext.endPopupShown = false;
      return;
    }
    if (payload.code !== roomCode || !payload.state?.gameOver) return;
    gameState = payload.state;
    players = payload.players || players;
    presence = payload.presence || presence;
    selected = null;
    legalMoves = [];
    renderGame();
    // Explicit terminal event is a second, authoritative signal for both clients.
    showMatchEndDialog();
  });
  socket.on('room-presence', updatePresence);
  socket.on('room-closed', (message) => {
    roomCode = null;
    myColor = null;
    gameState = null;
    selected = null;
    legalMoves = [];
    clearSession();
    setScreen('lobby');
    showLobbyMessage(message || 'The match was closed.', 'error');
  });
  socket.on('move-error', (message) => toast(message));
  socket.on('room-left', () => toast('You left the match.'));
  socket.on('match-restarted', (payload) => {
    if (gameMode === 'replay' && replayReturnContext?.roomCode && payload.code === replayReturnContext.roomCode) {
      replayReturnContext.gameState = payload.state;
      replayReturnContext.initialGameState = createInitialState();
      replayReturnContext.initialGameState.startedAt = payload.state.startedAt || Date.now();
      replayReturnContext.endPopupShown = false;
      return;
    }
    if (payload.code !== roomCode) return;
    endPopupShown = false;
    closeMatchEndDialog();
    gameState = payload.state;
    resetInitialGameState(gameState);
    selected = null;
    legalMoves = [];
    renderGame();
    toast('A fresh match has begun.');
  });
} else {
  setConnection(false, 'SERVER OFFLINE');
  showLobbyMessage('Online multiplayer client failed to load. Local play is still available.', 'error');
}

$('savedGamesNavBtn').addEventListener('click', openSavedGames);
$('savedGamesBackBtn').addEventListener('click', returnFromSavedGames);
$('syncSavedGamesBtn').addEventListener('click', () => syncSavedGames());
$('copyArchiveKeyBtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('archiveKeyInput').value || getArchiveKey());
    $('archiveSyncStatus').textContent = 'Private archive key copied. Keep it secret.';
  } catch {
    $('archiveKeyInput').type = 'text';
    $('archiveKeyInput').select();
    $('archiveSyncStatus').textContent = 'Select and copy the key manually. Keep it private.';
  }
});
$('useArchiveKeyBtn').addEventListener('click', async () => {
  try {
    setArchiveKey($('archiveKeyInput').value);
    $('archiveKeyInput').value = getArchiveKey();
    $('archiveSyncStatus').textContent = 'This device is now linked to that archive. Syncing…';
    await syncSavedGames();
    await refreshSavedGamesList();
  } catch (error) {
    $('archiveSyncStatus').textContent = error instanceof Error ? error.message : 'Could not link this archive.';
  }
});
$('exportSavedGamesBtn').addEventListener('click', exportSavedGamesBackup);
$('importSavedGamesBtn').addEventListener('click', () => $('importSavedGamesInput').click());
$('importSavedGamesInput').addEventListener('change', (event) => importSavedGamesBackup(event.target.files?.[0]));
$('replayPlayPauseBtn').addEventListener('click', () => replayPlaying ? pauseReplay() : startReplayPlayback());
$('replayRestartBtn').addEventListener('click', () => { setReplayPosition(0); startReplayPlayback(); });
$('replayPreviousBtn').addEventListener('click', () => setReplayPosition(replayIndex - 1));
$('replayNextBtn').addEventListener('click', () => { pauseReplay(); applyNextReplayMove(); });
$('replaySpeedSelect').addEventListener('change', (event) => {
  replaySpeed = event.target.value || 'original';
  if (replayPlaying) scheduleReplayMove();
  renderReplayControls();
});

$('createRoomBtn').addEventListener('click', createRoom);
$('localPlayBtn').addEventListener('click', startLocalGame);
$('computerPlayBtn').addEventListener('click', startComputerGame);
$('aiWatchBtn').addEventListener('click', startAiWatchGame);
const trainingKeyInput = $('trainingApiKeyInput');
try { trainingKeyInput.value = sessionStorage.getItem(TRAINING_KEY_SESSION) || ''; } catch {}
$('saveTrainingKeyBtn').addEventListener('click', () => {
  const key = trainingKeyInput.value.trim();
  try {
    if (key) sessionStorage.setItem(TRAINING_KEY_SESSION, key);
    else sessionStorage.removeItem(TRAINING_KEY_SESSION);
    $('trainingKeyMessage').textContent = key
      ? 'Key saved for this browser tab. You can now start a generation.'
      : 'Key cleared. Enter the server key to use live training.';
  } catch {
    $('trainingKeyMessage').textContent = 'This browser could not save the key for this tab. Check its privacy settings.';
  }
});
$('startTrainingBtn').addEventListener('click', startTraining);
$('stopTrainingBtn').addEventListener('click', stopTraining);
refreshTrainingStatus();
try { $('archiveKeyInput').value = getArchiveKey(); } catch (error) { $('archiveSyncStatus').textContent = error.message; }
refreshSavedGamesList();
if (navigator.onLine) syncSavedGames({ quiet: true });
window.addEventListener('online', () => { syncSavedGames({ quiet: true }); refreshSavedGamesList(); });
window.addEventListener('offline', () => { if ($('archiveSyncStatus')) $('archiveSyncStatus').textContent = 'Offline: saved games remain on this device and will sync after reconnecting.'; });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && navigator.onLine) syncSavedGames({ quiet: true }); });
$('localOrientationSelect').value = localOrientation;
$('localOrientationSelect').addEventListener('change', (event) => {
  localOrientation = event.target.value === 'fixed' ? 'fixed' : 'rotate';
  try { localStorage.setItem(settingsKeys.orientation, localOrientation); } catch {}
  updateVisualStyleControls();
  if (gameMode === 'local' && gameState) renderGame();
});
$('orientationSelect').addEventListener('change', (event) => {
  localOrientation = event.target.value === 'fixed' ? 'fixed' : 'rotate';
  $('localOrientationSelect').value = localOrientation;
  try { localStorage.setItem(settingsKeys.orientation, localOrientation); } catch {}
  if (gameMode === 'local' && gameState) renderGame();
});
$('visualStyleSelect').addEventListener('change', (event) => {
  visualStyle = event.target.value === 'merged' ? 'merged' : 'icons';
  try { localStorage.setItem(settingsKeys.visual, visualStyle); } catch {}
  updateVisualStyleControls();
  if (gameState) { renderBoard(); if (selected) renderPieceDetail(gameState.board[selected.y][selected.x]); }
});
updateVisualStyleControls();
$('joinRoomBtn').addEventListener('click', joinRoom);
$('roomCodeInput').addEventListener('input', (event) => { event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); });
$('roomCodeInput').addEventListener('keydown', (event) => { if (event.key === 'Enter') joinRoom(); });
$('copyRoomBtn').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(roomCode || ''); toast('Room code copied.'); }
  catch { toast(`Share this code: ${roomCode}`); }
});
$('leaveRoomBtn').addEventListener('click', () => {
  if (gameMode === 'replay') exitSavedGameReplay();
  else leaveRoom();
});
$('newGameBtn').addEventListener('click', () => {
  if (gameMode === 'computer') {
    startComputerGame();
    return;
  }
  if (gameMode === 'aiwatch') {
    startAiWatchGame();
    return;
  }
  if (gameMode === 'local') {
    endPopupShown = false;
    closeMatchEndDialog();
    gameState = createInitialState();
    resetInitialGameState(gameState);
    selected = null;
    legalMoves = [];
    renderGame();
    toast('A new local match has begun.');
    return;
  }
  if (socket?.connected && roomCode) socket.emit('restart-game', { code: roomCode });
});
$('saveMatchBtn').addEventListener('click', saveCurrentMatch);
$('viewMatchStatsBtn').addEventListener('click', openEndStatistics);
$('closeMatchEndBtn').addEventListener('click', closeMatchEndDialog);
$('backToEndAnnouncementBtn').addEventListener('click', backToEndAnnouncement);
$('closeEndStatsBtn').addEventListener('click', closeMatchEndDialog);
$('matchEndModal').addEventListener('click', (event) => {
  if (event.target === $('matchEndModal')) closeMatchEndDialog();
});
$('matchEndModal').addEventListener('close', () => {
  // Closing the announcement never resets endPopupShown; it stays dismissed
  // until a genuinely new match starts.
});
updateVisualStyleControls();
$('promotionModal').querySelectorAll('[data-promotion]').forEach((button) => {
  button.addEventListener('click', () => handlePromotion(button.dataset.promotion));
});
$('promotionModal').addEventListener('click', (event) => {
  if (event.target === $('promotionModal')) toast('Choose a piece to complete promotion.');
});

// Installable app support: Android/desktop use the native install prompt;
// iPhone/iPad users receive the Safari Add to Home Screen instruction.
let deferredInstallPrompt = null;
const installAppButton = $('installAppBtn');
const isAppleMobile = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.matchMedia('(display-mode: standalone)').matches;

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  installAppButton.classList.remove('hidden');
});

installAppButton.addEventListener('click', async () => {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    installAppButton.classList.add('hidden');
    return;
  }
  if (isAppleMobile) {
    toast('In Safari, tap Share, then choose “Add to Home Screen”.');
  } else {
    toast('Use your browser menu and choose “Install app” or “Add to home screen”.');
  }
});

window.addEventListener('appinstalled', () => {
  installAppButton.classList.add('hidden');
  toast('Chess Evolution installed.');
});

if (isAppleMobile) installAppButton.classList.remove('hidden');
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch((error) => {
      console.warn('App offline support could not be registered:', error);
    });
  });
}
