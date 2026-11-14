const SPECIAL_MOVEMENT_TYPES = Object.freeze(['queen', 'rook', 'bishop', 'knight']);

/** True when a non-king piece has all four special movement types. */
export function hasMaximumHybridCapabilities(piece) {
  if (!piece || piece.type === 'king') return false;
  const allowed = new Set(SPECIAL_MOVEMENT_TYPES);
  const owned = new Set([piece.type, ...(piece.powers || [])].filter((type) => allowed.has(type)));
  return SPECIAL_MOVEMENT_TYPES.every((type) => owned.has(type));
}

/** Resolve the board treatment, keeping the maximum star identical in both styles. */
export function getPieceVisualMode(piece, requestedStyle = 'icons') {
  if (!piece || piece.type === 'king') return 'icons';
  if (hasMaximumHybridCapabilities(piece)) return 'star';
  const additional = new Set((piece.powers || []).filter((type) =>
    SPECIAL_MOVEMENT_TYPES.includes(type) && type !== piece.type
  ));
  return requestedStyle === 'merged' && additional.size > 0 ? 'merged' : 'icons';
}
