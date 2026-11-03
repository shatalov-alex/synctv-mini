// PlaybackClientProfile for the `playback` observation, modelled on the
// official web profile (playback_client_profile_web.dart, profile_version 2)
// but narrowed to what this client can actually play: progressive files via
// <video> and HLS (native or hls.js on MediaSource). DASH / FLV / MPEG-TS are
// not advertised because we ship no dash.js / mpegts.js.
// Enums are proto integers (WS JSON uses integers).

const TRANSPORT_PROGRESSIVE = 1;
const TRANSPORT_HLS = 2;
const PIPELINE_NATIVE = 1;
const PIPELINE_MEDIA_SOURCE = 2;
const PIPELINE_MANAGED_MEDIA_SOURCE = 3;
const LIVE_TRANSPORT_HLS = 1;

interface Candidate {
  mime: string;
  container: number;
  video: number;
  audio: number;
  codecs: string;
}

const CANDIDATES: Candidate[] = [
  { mime: 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"', container: 1, video: 1, audio: 1, codecs: 'avc1.42E01E,mp4a.40.2' },
  { mime: 'video/mp4; codecs="hvc1.1.6.L93.B0, mp4a.40.2"', container: 1, video: 2, audio: 1, codecs: 'hvc1.1.6.L93.B0,mp4a.40.2' },
  { mime: 'video/webm; codecs="vp09.00.10.08, opus"', container: 3, video: 3, audio: 3, codecs: 'vp09.00.10.08,opus' },
  { mime: 'video/webm; codecs="av01.0.04M.08, opus"', container: 3, video: 4, audio: 3, codecs: 'av01.0.04M.08,opus' },
];

export interface MediaCapability {
  transport: number;
  container: number;
  videoCodec: number;
  audioCodec: number;
  pipeline: number;
  codecString: string;
}

type TypeSupport = { isTypeSupported?: (mime: string) => boolean };

function mseSupports(ctor: TypeSupport | undefined, mime: string): boolean {
  try {
    return !!ctor && typeof ctor.isTypeSupported === 'function' && ctor.isTypeSupported(mime);
  } catch {
    return false;
  }
}

export function buildClientProfile(): Record<string, unknown> {
  const video = document.createElement('video');
  const w = window as unknown as { MediaSource?: TypeSupport; ManagedMediaSource?: TypeSupport };
  const caps: MediaCapability[] = [];
  const add = (c: Candidate, transport: number, pipeline: number) =>
    caps.push({ transport, container: c.container, videoCodec: c.video, audioCodec: c.audio, pipeline, codecString: c.codecs });

  for (const c of CANDIDATES) {
    if (video.canPlayType(c.mime) !== '') add(c, TRANSPORT_PROGRESSIVE, PIPELINE_NATIVE);
    if (mseSupports(w.MediaSource, c.mime)) add(c, TRANSPORT_HLS, PIPELINE_MEDIA_SOURCE);
    if (mseSupports(w.ManagedMediaSource, c.mime)) add(c, TRANSPORT_HLS, PIPELINE_MANAGED_MEDIA_SOURCE);
  }
  if (video.canPlayType('application/vnd.apple.mpegurl') !== '') {
    for (const c of CANDIDATES) if (video.canPlayType(c.mime) !== '') add(c, TRANSPORT_HLS, PIPELINE_NATIVE);
  }

  const unique = (values: number[]) => values.filter((v, i) => values.indexOf(v) === i);
  const supportsHls = caps.some((c) => c.transport === TRANSPORT_HLS);
  return {
    profileVersion: 2,
    environment: 2, // WEB
    streamPreference: 1, // AUTO
    maxAudioChannels: 2,
    supportedVideoCodecs: unique(caps.map((c) => c.videoCodec)),
    supportedContainers: unique(caps.map((c) => c.container)),
    supportedLiveTransports: supportsHls ? [LIVE_TRANSPORT_HLS] : [],
    audioCapability: 1, // STEREO
    subtitlePreference: 1, // EXTERNAL
    mediaCapabilities: caps,
    supportsProviderProxy: true,
    supportsInsecureHttpMedia: location.protocol === 'http:',
  };
}
