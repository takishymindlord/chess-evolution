const SPECIAL_FORMS = ['queen', 'rook', 'bishop', 'knight'];
const LABELS = { queen: 'Queen', rook: 'Rook', bishop: 'Bishop', knight: 'Knight', pawn: 'Pawn' };

const escapeXml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
})[character]);

/**
 * Return a single fused SVG sculpture for a hybrid piece. The artwork is built
 * from full-size chess silhouettes and integrated details, rather than corner
 * badges. The complete four-power form remains the game's star emblem.
 */
export function mergedPieceSvg(piece) {
  if (!piece || piece.type === 'king') return '';
  const forms = new Set([piece.type, ...(piece.powers || [])].filter((type) => SPECIAL_FORMS.includes(type)));
  if (!SPECIAL_FORMS.some((type) => forms.has(type))) return '';
  if (SPECIAL_FORMS.every((type) => forms.has(type))) {
    return '<span class="merged-emblem merged-star" role="img" aria-label="Fully evolved star piece" title="All four special movement capabilities"><span>✦</span></span>';
  }

  // The most distinctive acquired silhouette becomes the core. Other forms
  // are fused into its crown, armor, body or tower details.
  const bodyForm = forms.has('knight') ? 'knight'
    : forms.has('queen') ? 'queen'
      : forms.has('bishop') ? 'bishop'
        : 'rook';
  const hasQueen = forms.has('queen');
  const hasRook = forms.has('rook');
  const hasBishop = forms.has('bishop');
  const id = String(piece.id || `${piece.color}-${piece.type}`).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'hybrid';
  const light = piece.color === 'white';
  const palette = light
    ? { dark: '#3e392f', mid: '#a99a78', bright: '#fff0c9', shade: '#716247', edge: '#28271f', accent: '#f2dda9' }
    : { dark: '#11191e', mid: '#68737a', bright: '#e0d3ad', shade: '#39444a', edge: '#090e12', accent: '#c6b17e' };
  const gradient = `metal-${id}`;
  const highlight = `highlight-${id}`;
  const bodyShapes = {
    queen: `<path d="M35 82 C31 72 34 62 40 55 C31 49 32 40 42 34 L58 34 C68 40 69 49 60 55 C66 62 69 72 65 82 Q50 88 35 82Z" fill="url(#${gradient})" stroke="${palette.edge}" stroke-width="2.4" stroke-linejoin="round"/><path d="M39 78 Q50 82 61 78" fill="none" stroke="${palette.bright}" stroke-width="2" opacity=".72"/>`,
    rook: `<path d="M30 82 L29 39 Q50 34 71 39 L70 82 Q50 88 30 82Z" fill="url(#${gradient})" stroke="${palette.edge}" stroke-width="2.4" stroke-linejoin="round"/><path d="M34 46 H66 M35 75 H65" stroke="${palette.bright}" stroke-width="2" opacity=".5"/>`,
    bishop: `<path d="M50 9 C64 21 68 31 60 42 C74 49 70 61 64 68 L65 82 Q50 88 35 82 L36 68 C30 61 26 49 40 42 C32 31 36 21 50 9Z" fill="url(#${gradient})" stroke="${palette.edge}" stroke-width="2.4" stroke-linejoin="round"/><path d="M50 17 L44 34 L56 47 L45 64" fill="none" stroke="${palette.bright}" stroke-width="4" stroke-linecap="round"/><path d="M43 67 Q50 73 57 67" fill="none" stroke="${palette.shade}" stroke-width="2"/>`,
    knight: `<path d="M28 83 C22 78 22 70 28 63 L38 53 C42 48 40 42 34 36 L27 29 C22 23 26 17 33 15 L34 7 L44 10 L49 20 L59 25 L68 35 L73 42 L66 49 L59 47 C54 52 52 59 56 66 L67 82 Q48 89 28 83Z" fill="url(#${gradient})" stroke="${palette.edge}" stroke-width="2.4" stroke-linejoin="round"/><path d="M32 26 Q40 28 45 37 M35 37 Q43 39 47 47 M39 48 Q46 50 51 57" fill="none" stroke="${palette.bright}" stroke-width="2.2" opacity=".72" stroke-linecap="round"/><path d="M31 20 L35 11 L40 23Z" fill="${palette.accent}" stroke="${palette.edge}" stroke-width="1.2"/><circle cx="35" cy="29" r="1.8" fill="${palette.bright}"/><path d="M25 65 Q33 60 39 59" fill="none" stroke="${palette.bright}" stroke-width="2" opacity=".5"/>`
  };

  const queenCrownTransform = bodyForm === 'knight' ? ' transform="translate(13 0) scale(.82 .86)"' : '';
  const queenCrown = hasQueen ? `<g class="fusion-crown"${queenCrownTransform}><path d="M25 30 L17 9 L34 22 L39 4 L50 21 L61 4 L66 22 L83 9 L75 30 Q50 36 25 30Z" fill="url(#${highlight})" stroke="${palette.edge}" stroke-width="2.1" stroke-linejoin="round"/><path d="M25 30 Q50 37 75 30 L72 37 H28Z" fill="url(#${gradient})" stroke="${palette.edge}" stroke-width="1.6"/><path d="M20 12 L26 25 M39 7 L43 23 M61 7 L57 23 M80 12 L74 25" stroke="${palette.bright}" stroke-width="1.8" opacity=".8"/><circle cx="17" cy="9" r="3.4" fill="${palette.bright}"/><circle cx="39" cy="4" r="3.4" fill="${palette.bright}"/><circle cx="61" cy="4" r="3.4" fill="${palette.bright}"/><circle cx="83" cy="9" r="3.4" fill="${palette.bright}"/></g>` : '';

  const rookCrown = hasRook && bodyForm === 'rook' ? `<g class="fusion-rook-top"><path d="M25 42 V19 H37 V30 H46 V19 H55 V30 H64 V19 H76 V42Z" fill="url(#${highlight})" stroke="${palette.edge}" stroke-width="2.2" stroke-linejoin="round"/><path d="M29 40 H72" stroke="${palette.bright}" stroke-width="2" opacity=".75"/></g>` : '';
  const rookBand = hasRook && bodyForm !== 'rook' ? `<g class="fusion-rook-band"><path d="M29 57 V51 H38 V56 H46 V50 H55 V56 H63 V51 H72 V65 Q50 70 29 65Z" fill="url(#${highlight})" stroke="${palette.edge}" stroke-width="2" stroke-linejoin="round"/><path d="M33 64 Q50 68 68 64" fill="none" stroke="${palette.bright}" stroke-width="1.7" opacity=".8"/></g>` : '';
  const bishopInlay = hasBishop && bodyForm !== 'bishop' ? `<g class="fusion-bishop-inlay"><path d="M50 38 C39 47 40 59 50 68 C60 59 61 47 50 38Z" fill="url(#${highlight})" stroke="${palette.edge}" stroke-width="1.8"/><path d="M44 48 L56 60" stroke="${palette.bright}" stroke-width="2.4" stroke-linecap="round"/><path d="M50 42 L50 64" stroke="${palette.shade}" stroke-width="1.4" opacity=".8"/></g>` : '';

  const title = [...forms].map((type) => LABELS[type]).join(' + ');
  const base = `<ellipse cx="50" cy="88" rx="30" ry="5" fill="${palette.edge}" opacity=".8"/><path d="M19 84 Q50 78 81 84 L77 92 Q50 98 23 92Z" fill="url(#${gradient})" stroke="${palette.edge}" stroke-width="2.1"/><path d="M25 84 Q50 80 75 84" fill="none" stroke="${palette.bright}" stroke-width="2" opacity=".75"/><path d="M29 91 Q50 95 71 91" fill="none" stroke="${palette.shade}" stroke-width="1.7"/>`;

  return `<span class="merged-emblem merged-sculpture" role="img" aria-label="Merged ${escapeXml(title)} chess piece" title="${escapeXml(title)} hybrid"><svg class="merged-art" viewBox="0 0 100 100" aria-hidden="true" focusable="false"><defs><linearGradient id="${gradient}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${palette.dark}"/><stop offset=".2" stop-color="${palette.mid}"/><stop offset=".48" stop-color="${palette.bright}"/><stop offset=".68" stop-color="${palette.shade}"/><stop offset="1" stop-color="${palette.dark}"/></linearGradient><linearGradient id="${highlight}" x1="0" y1="0" x2=".8" y2="1"><stop offset="0" stop-color="${palette.bright}"/><stop offset=".45" stop-color="${palette.mid}"/><stop offset="1" stop-color="${palette.dark}"/></linearGradient></defs><g class="hybrid-sculpture-body">${bodyShapes[bodyForm]}${base}${rookCrown}${queenCrown}${bishopInlay}${rookBand}</g></svg></span>`;
}

