export function originalMoveDelay(moves, index, startedAt, fallbackMs = 500) {
  const current = Number(moves?.[index]?.playedAt);
  const previous = index > 0 ? Number(moves?.[index - 1]?.playedAt) : Number(startedAt);
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return fallbackMs;
  return Math.max(0, Math.min(24 * 60 * 60 * 1000, current - previous));
}

export function scaledMoveDelay(moves, index, startedAt, speed = 'original', fallbackMs = 500) {
  const original = originalMoveDelay(moves, index, startedAt, fallbackMs);
  const multiplier = speed === 'original' ? 1 : Number(speed);
  if (!Number.isFinite(multiplier) || multiplier <= 0) return original;
  return Math.round(original / multiplier);
}

export function formatElapsed(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}
