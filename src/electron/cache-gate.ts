/** Drain path-to-file-open operations before changing the cache directory. */
export class CacheOperationGate {
  private changing: Promise<void> | null = null;
  private inFlight = new Set<Promise<void>>();
  async read<T>(operation: () => Promise<T>): Promise<T> {
    while (this.changing) await this.changing;
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    this.inFlight.add(done);
    try { return await operation(); }
    finally { this.inFlight.delete(done); finish(); }
  }
  async change<T>(operation: () => Promise<T>): Promise<T> {
    while (this.changing) await this.changing;
    let finish!: () => void;
    this.changing = new Promise<void>((resolve) => { finish = resolve; });
    try {
      await Promise.all([...this.inFlight]);
      return await operation();
    } finally { this.changing = null; finish(); }
  }
}
