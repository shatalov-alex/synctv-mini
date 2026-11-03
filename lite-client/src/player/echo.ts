// Echo suppression: when we change the <video> element programmatically (to
// apply remote state), the element fires the same events a user action would.
// Each programmatic change registers an expectation; the matching event
// consumes it and is reported as programmatic instead of external.

export type EchoKind = 'play' | 'pause' | 'seek' | 'rate';

export class EchoGuard {
  private pending: Record<EchoKind, number[]> = { play: [], pause: [], seek: [], rate: [] };

  constructor(
    private readonly now: () => number = () => Date.now(),
    /** Expectations not matched within this window are dropped (the event never fired). */
    private readonly windowMs = 2000,
  ) {}

  expect(kind: EchoKind): void {
    this.prune(kind);
    this.pending[kind].push(this.now() + this.windowMs);
  }

  /** True if the event was caused by our own programmatic change. */
  consume(kind: EchoKind): boolean {
    this.prune(kind);
    return this.pending[kind].shift() !== undefined;
  }

  /** Drop an expectation that will not fire after all (e.g. play() rejected). */
  cancel(kind: EchoKind): void {
    this.pending[kind].pop();
  }

  clear(): void {
    this.pending = { play: [], pause: [], seek: [], rate: [] };
  }

  private prune(kind: EchoKind): void {
    const now = this.now();
    const list = this.pending[kind];
    while (list.length && list[0] < now) list.shift();
  }
}
