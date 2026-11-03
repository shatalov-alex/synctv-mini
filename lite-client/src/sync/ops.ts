// Port of playback_operation_tracker.dart: remembers the state before each
// local command so a server rejection can roll back, and classifies incoming
// states carrying our own clientOperationId.

export interface Resolution<T> {
  handled: boolean;
  /** State to apply; for acknowledge this means "store it, don't touch the player". */
  state?: T;
}

interface Operation<T> {
  previousState: T;
  previousOperationId: string | null;
  createdAt: number;
  acknowledged: boolean;
}

export class OpTracker<T> {
  private ops = new Map<string, Operation<T>>();
  private active: string | null = null;

  constructor(
    private readonly retentionMs = 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  remember(opId: string, previousState: T): void {
    const createdAt = this.now();
    this.removeExpired(createdAt);
    this.ops.set(opId, { previousState, previousOperationId: this.active, createdAt, acknowledged: false });
    this.active = opId;
  }

  acknowledge(opId: string, authoritative: T): Resolution<T> {
    this.removeExpired(this.now());
    const op = opId ? this.ops.get(opId) : undefined;
    if (!op) return { handled: false };
    if (op.acknowledged) return { handled: true };
    op.acknowledged = true;
    if (this.active === opId) {
      this.active = null;
      return { handled: true, state: authoritative };
    }
    const dependent = this.dependentOf(opId);
    if (dependent) {
      dependent.previousState = authoritative;
      dependent.previousOperationId = op.previousOperationId;
    }
    return { handled: true };
  }

  reject(opId: string): Resolution<T> {
    this.removeExpired(this.now());
    const op = this.ops.get(opId);
    this.ops.delete(opId);
    if (!op || op.acknowledged) return { handled: false };
    if (this.active === opId) {
      this.active = op.previousOperationId;
      return { handled: true, state: op.previousState };
    }
    const dependent = this.dependentOf(opId);
    if (dependent) {
      dependent.previousState = op.previousState;
      dependent.previousOperationId = op.previousOperationId;
    }
    return { handled: true };
  }

  get activeOperationId(): string | null {
    return this.active;
  }

  private dependentOf(opId: string): Operation<T> | null {
    let found: Operation<T> | null = null;
    this.ops.forEach((op) => {
      if (!found && op.previousOperationId === opId) found = op;
    });
    return found;
  }

  private removeExpired(now: number): void {
    const expired: string[] = [];
    this.ops.forEach((op, id) => {
      if (now - op.createdAt > this.retentionMs) expired.push(id);
    });
    for (const id of expired) {
      this.ops.delete(id);
      if (this.active === id) this.active = null;
    }
  }
}

/** RFC 4122 v4 UUID; crypto.randomUUID is missing on older TV engines and insecure origins. */
export function uuidv4(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c && typeof c.randomUUID === 'function') {
    try {
      return c.randomUUID();
    } catch {
      // insecure context: fall through
    }
  }
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex: string[] = [];
  for (let i = 0; i < 16; i++) hex.push((bytes[i] + 0x100).toString(16).slice(1));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
}
