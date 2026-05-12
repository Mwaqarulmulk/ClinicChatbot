type Entry = { count: number; resetAt: number };

export class WindowGuard {
  private entries = new Map<string, Entry>();
  private sweepTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {
    // Proactively sweep expired entries every 5 minutes so the map doesn't
    // grow unbounded when many unique keys (e.g. WhatsApp JIDs) are seen over time.
    this.sweepTimer = setInterval(() => this.sweep(Date.now()), 5 * 60_000);
    // Don't prevent Node from exiting naturally
    if (typeof this.sweepTimer.unref === "function") this.sweepTimer.unref();
  }

  allow(key: string): boolean {
    const now = Date.now();
    const current = this.entries.get(key);
    if (!current || current.resetAt <= now) {
      this.entries.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (current.count >= this.limit) return false;
    current.count += 1;
    return true;
  }

  /** Release resources when this guard is no longer needed. */
  destroy() {
    clearInterval(this.sweepTimer);
    this.entries.clear();
  }

  private sweep(now: number) {
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) this.entries.delete(key);
    }
  }
}

export class TtlSet {
  private values = new Map<string, number>();

  constructor(private readonly ttlMs: number) {}

  hasOrAdd(value: string): boolean {
    const now = Date.now();
    this.sweep(now);
    if (this.values.has(value)) return true;
    this.values.set(value, now + this.ttlMs);
    return false;
  }

  private sweep(now: number) {
    for (const [key, expiresAt] of this.values) {
      if (expiresAt <= now) this.values.delete(key);
    }
  }
}
