const DATABASE_NAME = 'chess-evolution-saved-games';
const DATABASE_VERSION = 1;
const GAME_STORE = 'games';
const TOMBSTONES_KEY = 'chessEvolution.deletedSavedGames';
const ARCHIVE_KEY = 'chessEvolution.archiveKey';

function openDatabase() {
  if (!('indexedDB' in globalThis)) {
    return Promise.reject(new Error('This browser does not support local game storage. Please use a modern browser.'));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(GAME_STORE)) {
        const store = database.createObjectStore(GAME_STORE, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open saved-game storage.'));
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Saved-game storage request failed.'));
  });
}

async function withStore(mode, callback) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(GAME_STORE, mode);
    const store = transaction.objectStore(GAME_STORE);
    const result = await callback(store);
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('Saved-game storage transaction failed.'));
      transaction.onabort = () => reject(transaction.error || new Error('Saved-game storage transaction was aborted.'));
    });
    return result;
  } finally {
    database.close();
  }
}

export async function listSavedGames() {
  const games = await withStore('readonly', (store) => requestResult(store.getAll()));
  return games.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
}

export async function putSavedGame(game) {
  if (!game || typeof game.id !== 'string') throw new Error('A saved game needs a valid ID.');
  return withStore('readwrite', (store) => requestResult(store.put(game)));
}

export async function putSavedGames(games) {
  return withStore('readwrite', async (store) => {
    for (const game of games) {
      if (game && typeof game.id === 'string') await requestResult(store.put(game));
    }
    return games.length;
  });
}

export async function removeSavedGame(id) {
  return withStore('readwrite', (store) => requestResult(store.delete(id)));
}

export function getArchiveKey() {
  try {
    let key = localStorage.getItem(ARCHIVE_KEY);
    if (!key) {
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      key = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
      localStorage.setItem(ARCHIVE_KEY, key);
    }
    return key;
  } catch {
    throw new Error('Local storage is unavailable, so this device cannot create a cloud-sync key.');
  }
}

export function setArchiveKey(value) {
  const key = String(value || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Archive sync keys must contain exactly 64 hexadecimal characters.');
  localStorage.setItem(ARCHIVE_KEY, key);
  return key;
}

export function getDeletedGameIds() {
  try {
    const value = JSON.parse(localStorage.getItem(TOMBSTONES_KEY) || '[]');
    return Array.isArray(value) ? value.filter((id) => typeof id === 'string') : [];
  } catch { return []; }
}

export function rememberDeletedGame(id) {
  const ids = new Set(getDeletedGameIds());
  ids.add(id);
  try { localStorage.setItem(TOMBSTONES_KEY, JSON.stringify([...ids])); } catch {}
}

export function forgetDeletedGame(id) {
  const ids = getDeletedGameIds().filter((item) => item !== id);
  try { localStorage.setItem(TOMBSTONES_KEY, JSON.stringify(ids)); } catch {}
}
