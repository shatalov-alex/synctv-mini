// Remote-control key mapping for the TV page. Old TV engines report
// `keyCode` only (and vendor codes), so map both.

export type TvAction = 'toggle' | 'back10' | 'forward10' | 'play' | 'pause' | 'next' | 'prev' | 'menu' | 'unpair' | null;

const BY_KEY: Record<string, TvAction> = {
  ' ': 'toggle',
  Spacebar: 'toggle',
  Enter: 'toggle',
  MediaPlayPause: 'toggle',
  ArrowLeft: 'back10',
  Left: 'back10',
  MediaRewind: 'back10',
  ArrowRight: 'forward10',
  Right: 'forward10',
  MediaFastForward: 'forward10',
  MediaPlay: 'play',
  MediaPause: 'pause',
  MediaTrackNext: 'next',
  MediaTrackPrevious: 'prev',
  ArrowUp: 'menu',
  ArrowDown: 'menu',
  Up: 'menu',
  Down: 'menu',
  ColorF0Red: 'unpair',
};

const BY_CODE: Record<number, TvAction> = {
  13: 'toggle',
  32: 'toggle',
  179: 'toggle', // MediaPlayPause
  10252: 'toggle', // Tizen MediaPlayPause
  37: 'back10',
  412: 'back10', // Rewind (Tizen / webOS)
  39: 'forward10',
  417: 'forward10', // FastForward
  415: 'play',
  19: 'pause',
  176: 'next',
  425: 'next',
  177: 'prev',
  424: 'prev',
  38: 'menu',
  40: 'menu',
  403: 'unpair', // red colour key
};

export function tvAction(key: string | undefined, keyCode: number | undefined): TvAction {
  if (key && key !== 'Unidentified' && BY_KEY[key] !== undefined) return BY_KEY[key];
  if (keyCode !== undefined && BY_CODE[keyCode] !== undefined) return BY_CODE[keyCode];
  return null;
}
