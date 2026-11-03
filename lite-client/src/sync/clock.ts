// Server clock offset, ported from the official client (synced_clock.dart,
// synctv_service.dart:391-417): one NTP-style sample from /api/public/time
// every 30 s, no smoothing; each valid sample replaces the previous offset.

export const TIME_SYNC_INTERVAL_MS = 30_000;
export const TIME_SYNC_TIMEOUT_MS = 5_000;

/** Parses an int64 nanosecond string into fractional milliseconds without losing precision. */
export function nanosToMs(value: string | number | undefined): number {
  if (value === undefined || value === null) return 0;
  const s = String(value).trim();
  if (!/^-?\d+$/.test(s)) return Number(s) / 1e6 || 0;
  if (s.length <= 6) return Number(s) / 1e6;
  return Number(s.slice(0, -6)) + Number(s.slice(-6)) / 1e6;
}

export interface TimeSample {
  /** Local ms when the request was sent. */
  t0: number;
  /** Server receive / send times, ms. */
  t1: number;
  t2: number;
  /** Local ms when the response arrived. */
  t3: number;
}

/** Returns server-minus-local offset in ms, or null when the sample must be discarded. */
export function offsetFromSample({ t0, t1, t2, t3 }: TimeSample): number | null {
  if (t0 <= 0 || t1 <= 0 || t2 <= 0 || t3 <= 0) return null;
  if (t3 < t0 || t2 < t1) return null;
  const rtt = t3 - t0 - (t2 - t1);
  if (rtt < 0) return null;
  return (t1 - t0 + (t2 - t3)) / 2;
}

interface TimeResponse {
  clientSentAtNanos?: string;
  serverReceivedAtNanos?: string;
  serverSentAtNanos?: string;
}

export type TimeFetcher = (clientSentAtNanos: string) => Promise<TimeResponse>;

export class ServerClock {
  private offsetMs = 0;
  private revision = 0;
  private inFlight = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly fetchTime: TimeFetcher,
    private readonly localNow: () => number = () => Date.now(),
  ) {}

  /** Server time estimate in unix ms. */
  now(): number {
    return this.localNow() + this.offsetMs;
  }

  get offset(): number {
    return this.offsetMs;
  }

  start(): void {
    if (this.timer !== null) return;
    void this.sample();
    this.timer = setInterval(() => void this.sample(), TIME_SYNC_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.revision++;
  }

  async sample(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    const revision = ++this.revision;
    const t0 = this.localNow();
    // Send ms * 1e6 as a string: Number would lose precision above 2^53.
    const sent = `${Math.floor(t0)}000000`;
    try {
      const response = await this.fetchTime(sent);
      if (revision !== this.revision) return;
      const t3 = this.localNow();
      if (String(response.clientSentAtNanos || '') !== sent) return; // stale response
      const offset = offsetFromSample({
        t0: Math.floor(t0),
        t1: nanosToMs(response.serverReceivedAtNanos),
        t2: nanosToMs(response.serverSentAtNanos),
        t3,
      });
      if (offset !== null) this.offsetMs = offset;
    } catch {
      // Fidelity with the official client: a failed sample resets the offset to 0
      // (spec §2.3, ambiguity 6). Kept deliberately; see README "Sync".
      if (revision === this.revision) this.offsetMs = 0;
    } finally {
      this.inFlight = false;
    }
  }
}
