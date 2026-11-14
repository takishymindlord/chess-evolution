import { createInitialState, getLegalMoves, PIECE_NAMES, playMove } from './engine.js';
import { mergedPieceSvg } from './merged-art.js';

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
let players = { white: null, black: null };
let presence = { white: false, black: false };
let selected = null;
let legalMoves = [];
let pendingPromotion = null;
let toastTimer = null;
let localOrientation = readSetting(settingsKeys.orientation, 'rotate') === 'fixed' ? 'fixed' : 'rotate';
let visualStyle = readSetting(settingsKeys.visual, 'icons') === 'merged' ? 'merged' : 'icons';
let endPopupShown = false;

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
  $('lobbyScreen').classList.toggle('hidden', screen !== 'lobby');
  $('gameScreen').classList.toggle('hidden', screen !== 'game');
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
  endPopupShown = false;
  $('matchEndModal').classList.add('hidden');
  gameMode = 'local';
  roomCode = null;
  myColor = 'white';
  gameState = createInitialState();
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
  endPopupShown = false;
  $('matchEndModal').classList.add('hidden');
  gameMode = 'online';
  roomCode = payload.code;
  myColor = payload.color;
  gameState = payload.state;
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
  if (gameMode === 'local') {
    try {
      const { record } = playMove(gameState, from, to, promotion);
      selected = null;
      legalMoves = [];
      renderGame();
      if (record.inherited?.length) {
        toast(`${record.color === 'white' ? 'White' : 'Black'} inherited ${record.inherited.map((type) => PIECE_NAMES[type]).join(' + ')}.`);
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : 'That move could not be completed.');
    }
    return;
  }
  if (!socket?.connected || !roomCode) return toast('Connection lost. Reconnecting…');
  socket.emit('make-move', { code: roomCode, from, to, promotion });
}

function leaveRoom() {
  if (gameMode === 'online' && socket?.connected && roomCode) socket.emit('leave-room', { code: roomCode });
  roomCode = null;
  myColor = null;
  endPopupShown = false;
  $('matchEndModal').classList.add('hidden');
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
  return gameMode === 'local' ? (localOrientation === 'rotate' ? gameState.turn : 'white') : myColor;
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
    const identityMarkup = piece
      ? (visualStyle === 'merged' && isHybrid
        ? makeMergedVisual(piece)
        : `<span class="piece-glyph">${glyphs[piece.color][piece.type]}</span>${isHybrid ? makePowerBadges(piece) : ''}`)
      : '';
    const pieceMarkup = piece ? `<span class="piece ${piece.color} ${isHybrid ? 'hybrid' : ''} ${visualStyle === 'merged' ? 'merged-style' : ''}">${isHybrid ? '<span class="piece-halo"></span>' : ''}${identityMarkup}</span>` : '';
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
  if (!gameState || (gameMode === 'online' && !players.black)) return;
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
  $('selfStrip').querySelector('.you-tag').textContent = 'YOU';

  const opponentColor = myColor === 'white' ? 'black' : 'white';
  const me = players[myColor];
  const opponent = players[opponentColor];
  $('selfName').textContent = me?.name || 'You';
  $('selfMeta').textContent = `${myColor.toUpperCase()} · YOU · ${gameState.captured?.[myColor]?.length || 0} CAPTURES`;
  $('selfAvatar').textContent = glyphs[myColor].king;
  $('selfAvatar').className = `player-avatar ${myColor === 'white' ? 'white-avatar' : 'black-avatar'}`;
  $('opponentName').textContent = opponent?.name || 'Waiting for opponent';
  $('opponentMeta').textContent = `${opponentColor.toUpperCase()} · ${presence[opponentColor] ? 'CONNECTED' : 'NOT CONNECTED'} · ${gameState.captured?.[opponentColor]?.length || 0} CAPTURES`;
  $('opponentAvatar').textContent = glyphs[opponentColor].king;
  $('opponentAvatar').className = `player-avatar ${opponentColor === 'white' ? 'white-avatar' : 'black-avatar'}`;
  $('opponentPresence').classList.toggle('online', Boolean(presence[opponentColor]));
  $('opponentPresence').classList.toggle('offline', !presence[opponentColor]);
}

function renderStatus() {
  const isLocal = gameMode === 'local';
  const yourTurn = gameState.turn === myColor;
  const activeName = gameState.turn === 'white' ? 'White' : 'Black';
  const headline = $('turnHeadline');
  const label = $('turnLabel');
  const icon = $('turnIcon');
  const subline = $('statusSubline');
  const isWaiting = !isLocal && !players.black;
  const checkmate = gameState.status === 'checkmate';
  const stalemate = gameState.status === 'stalemate';
  icon.textContent = glyphs[gameState.turn].king;
  icon.className = `turn-icon ${gameState.turn === 'white' ? 'white-turn' : 'black-turn'}`;
  $('newGameBtn').classList.toggle('hidden', !gameState.gameOver);

  if (isWaiting) {
    label.textContent = 'ROOM OPEN';
    headline.textContent = 'Waiting for player…';
    subline.textContent = `Share room ${roomCode} with a friend to begin.`;
  } else if (checkmate) {
    label.textContent = 'CHECKMATE';
    headline.textContent = isLocal ? `${gameState.winner === 'white' ? 'White' : 'Black'} wins.` : (gameState.winner === myColor ? 'You won.' : 'You were defeated.');
    subline.textContent = 'The king has no safe escape. The match is complete.';
  } else if (stalemate) {
    label.textContent = 'STALEMATE';
    headline.textContent = 'A drawn match.';
    subline.textContent = 'No legal moves remain, but the king is not in check.';
  } else if (gameState.check) {
    label.textContent = `${gameState.check.toUpperCase()} KING IN CHECK`;
    headline.textContent = isLocal ? `${gameState.check === 'white' ? 'White' : 'Black'} king is under attack.` : (gameState.check === myColor ? 'Your king is under attack.' : 'Opponent is in check.');
    subline.textContent = 'Find a legal escape before the next move.';
  } else {
    label.textContent = `${gameState.turn.toUpperCase()} TO MOVE`;
    headline.textContent = isLocal ? `${activeName} to move.` : (yourTurn ? 'Your move.' : 'Opponent’s turn.');
    subline.textContent = isLocal
      ? (localOrientation === 'rotate' ? `${activeName} to play. The board rotates toward the next player.` : `${activeName} to play. The board stays fixed with White at the bottom.`)
      : (yourTurn ? 'Capture to evolve your pieces.' : 'Watch their pieces. Every capture matters.');
  }

  const last = gameState.history.at(-1);
  if (!gameState.gameOver && last?.inherited?.length) {
    const names = [...new Set(last.inherited)].map((type) => PIECE_NAMES[type]).join(', ');
    const playerLabel = isLocal ? (last.color === 'white' ? 'White' : 'Black') : (last.color === myColor ? 'You' : 'Opponent');
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
  panel.innerHTML = `<div class="stats-heading"><b>MATCH STATISTICS</b><strong>${escapeHtml(result)}</strong></div><div class="stats-total"><span>${history.length} total plies</span><span>${gameState.status === 'checkmate' ? 'Checkmate' : 'Stalemate'}</span></div><div class="stats-columns">${statColumn('white', white)}${statColumn('black', black)}</div>`;
  // Statistics are deliberately opened from the match-end dialog, not
  // permanently exposed in the sidebar underneath the board.
  panel.classList.add('hidden');
}

function showMatchEndDialog() {
  if (!gameState?.gameOver || endPopupShown) return;
  endPopupShown = true;
  const winnerColor = gameState.winner;
  const winner = winnerColor ? (players[winnerColor]?.name || (winnerColor === 'white' ? 'White' : 'Black')) : null;
  $('matchEndEyebrow').textContent = gameState.status === 'checkmate' ? 'CHECKMATE' : 'STALEMATE';
  $('matchEndTitle').textContent = winner ? `${winner} wins!` : 'The match is a draw';
  $('matchEndMessage').textContent = gameState.status === 'checkmate'
    ? `${winner || 'The winner'} delivered checkmate. The king has no legal escape.`
    : 'No legal moves remain, but the king is not in check. The match is drawn.';
  $('endStatisticsContent').innerHTML = $('matchStats').innerHTML;
  $('endAnnouncementView').classList.remove('hidden');
  $('endStatisticsView').classList.add('hidden');
  $('matchEndModal').classList.remove('hidden');
}

function closeMatchEndDialog() {
  $('matchEndModal').classList.add('hidden');
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
  showMatchEndDialog();
  if (selected) renderPieceDetail(gameState.board[selected.y][selected.x]);
}

function updatePresence(payload) {
  if (!payload || payload.code !== roomCode) return;
  players = payload.players || players;
  presence = payload.presence || presence;
  renderPlayers();
  renderStatus();
}

if (socket) {
  socket.on('connect', () => {
    setConnection(gameMode !== 'local', gameMode === 'local' ? 'LOCAL MODE' : 'CONNECTED');
    const saved = savedSession();
    if (saved?.code && saved.playerId === playerId && !roomCode) {
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
    if (payload.code !== roomCode) return;
    endPopupShown = false;
    $('matchEndModal').classList.add('hidden');
    gameState = payload.state;
    selected = null;
    legalMoves = [];
    renderGame();
    toast('A fresh match has begun.');
  });
} else {
  setConnection(false, 'SERVER OFFLINE');
  showLobbyMessage('Online multiplayer client failed to load. Local play is still available.', 'error');
}

$('createRoomBtn').addEventListener('click', createRoom);
$('localPlayBtn').addEventListener('click', startLocalGame);
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
$('leaveRoomBtn').addEventListener('click', leaveRoom);
$('newGameBtn').addEventListener('click', () => {
  if (gameMode === 'local') {
    endPopupShown = false;
    $('matchEndModal').classList.add('hidden');
    gameState = createInitialState();
    selected = null;
    legalMoves = [];
    renderGame();
    toast('A new local match has begun.');
    return;
  }
  if (socket?.connected && roomCode) socket.emit('restart-game', { code: roomCode });
});
$('viewMatchStatsBtn').addEventListener('click', openEndStatistics);
$('closeMatchEndBtn').addEventListener('click', closeMatchEndDialog);
$('backToEndAnnouncementBtn').addEventListener('click', backToEndAnnouncement);
$('closeEndStatsBtn').addEventListener('click', closeMatchEndDialog);
$('matchEndModal').addEventListener('click', (event) => {
  if (event.target === $('matchEndModal')) closeMatchEndDialog();
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
