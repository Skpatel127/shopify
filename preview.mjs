const PALETTES = {
  source: 'preserve the subject artwork’s original colours, using natural relief shadows',
  royal: 'rich royal jewel tones with deep blue, ruby red, emerald green and restrained gold accents',
  peacock: 'peacock teal and blue with warm antique-gold accents',
  garden: 'saffron, leaf green and warm gold',
  reference: 'take the relief colour palette from the separately supplied colour-reference image',
  custom: 'preserve the source palette and use the specified custom accent colour',
};

const SHAPES = {
  round: { label: 'a round medallion plaque', aspectRatio: '1:1' },
  square: { label: 'a square plaque', aspectRatio: '1:1' },
  landscape: { label: 'a wide landscape rectangular plaque', aspectRatio: '4:3' },
  portrait: { label: 'a tall portrait rectangular plaque', aspectRatio: '3:4' },
  arch: { label: 'an elegant arched plaque with a curved top', aspectRatio: '3:4' },
};

const LIGHT_DIRECTIONS = {
  'upper-left': 'warm sunlight from the upper left',
  'upper-right': 'warm sunlight from the upper right',
  side: 'soft directional side light',
  front: 'bright, soft frontal daylight',
};

export function getPreviewSpec(fields = {}, { hasReference = false } = {}) {
  const palette = String(fields.palette || 'source');
  const shape = String(fields.shape || 'landscape');
  const lightDirection = String(fields.lightDirection || 'upper-left');
  const lightStrength = Number(fields.lightStrength ?? 70);
  const customColor = String(fields.customColor || '').toUpperCase();

  if (!Object.hasOwn(PALETTES, palette)) throw new TypeError('Choose a supported artwork palette.');
  if (!Object.hasOwn(SHAPES, shape)) throw new TypeError('Choose a supported panel shape.');
  if (!Object.hasOwn(LIGHT_DIRECTIONS, lightDirection)) throw new TypeError('Choose a supported light direction.');
  if (!Number.isInteger(lightStrength) || lightStrength < 20 || lightStrength > 100) {
    throw new TypeError('Sunlight strength must be from 20 to 100.');
  }
  if (palette === 'reference' && !hasReference) {
    throw new TypeError('Upload a colour-reference image to use that palette.');
  }
  if (palette === 'custom' && !/^#[0-9A-F]{6}$/.test(customColor)) {
    throw new TypeError('Enter a valid six-digit custom accent colour.');
  }

  return {
    palette,
    paletteDescription: PALETTES[palette],
    customColor: palette === 'custom' ? customColor : null,
    shape,
    shapeDescription: SHAPES[shape].label,
    aspectRatio: SHAPES[shape].aspectRatio,
    lightDirection,
    lightDescription: LIGHT_DIRECTIONS[lightDirection],
    lightStrength,
    hasReference,
  };
}

export function buildReliefPrompt(spec) {
  const colorInstruction = spec.palette === 'custom'
    ? `${spec.paletteDescription} (${spec.customColor}).`
    : `${spec.paletteDescription}.`;
  const referenceInstruction = spec.hasReference
    ? 'The second attached image, if present, is only a colour reference. Use its colours, not its subject or composition.'
    : 'There is no separate colour-reference image.';

  return [
    'Create exactly ONE photorealistic product concept image from the customer artwork.',
    'Treat the first attached image as the source artwork and preserve its recognizable subject, identity, pose, composition, orientation and important details. Do not replace it with a different subject.',
    referenceInstruction,
    `Transform the subject into a richly detailed, full-colour sculpted bas-relief wall-art plaque: ${spec.shapeDescription}. Show genuine carved depth, raised forms and fine relief contours while keeping the source subject recognizable.`,
    `Artwork palette: ${colorInstruction}`,
    `Lighting: ${spec.lightDescription}, strength ${spec.lightStrength} percent, with believable warm highlights and dimensional cast shadows.`,
    'Show the complete plaque as a premium handcrafted wall-art product against a simple warm neutral wall, with a slight three-quarter camera angle that makes the relief depth visible. Keep the artwork itself the focus.',
    'Return one standalone image only. Do not make a collage, comparison, grid, extra variants, labels, lettering, watermark or border.',
    'This is an illustrative design concept, not a CAD model, manufacturing file or guarantee of a physical result.',
  ].join(' ');
}
