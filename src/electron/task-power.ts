/** Keep ordinary batch rests awake, but release for manual/protective pauses. */
export function tasksNeedAwake(
  stats: any,
  pixiv: any,
  ai: any,
  sauce?: any,
  danbooru?: any,
): boolean {
  const danbooruCount = (status: string) =>
    danbooru?.counts?.find((v: any) => v.status === status)?.count ?? 0;
  if (
    danbooruCount("running") > 0 ||
    (!danbooru?.paused && danbooruCount("waiting") > 0)
  )
    return true;
  const sauceCount = (status: string) =>
    sauce?.counts?.find((v: any) => v.status === status)?.count ?? 0;
  if (
    sauceCount("running") > 0 ||
    (!sauce?.paused && sauceCount("waiting") > 0)
  )
    return true;
  const local = stats.local;
  if (stats.activity?.scanningRootId || stats.activity?.processing) return true;
  if (
    local &&
    ((!local.scanPaused && (local.activeRoot || local.pendingRoots?.length)) ||
      (!local.imagesPaused && local.images?.pending > 0))
  )
    return true;
  if (
    ai.queues?.some(
      (queue: any) =>
        queue.counts.running > 0 || (!queue.paused && queue.counts.waiting > 0),
    )
  )
    return true;
  const count = (name: string) =>
    pixiv.counts?.find((item: any) => item.status === name)?.count ?? 0;
  return (
    count("running") > 0 ||
    ((!pixiv.source.paused ||
      (pixiv.source.reason === "batch_rest" &&
        pixiv.source.settings.autoRest)) &&
      (pixiv.source.scopePending ?? count("waiting") + count("retry_wait")) > 0)
  );
}

export class TaskPowerGuard {
  private id: number | undefined;
  constructor(
    private blocker: {
      start(type: "prevent-app-suspension"): number;
      stop(id: number): void;
    },
  ) {}
  get active() {
    return this.id !== undefined;
  }
  update(needed: boolean) {
    if (needed && this.id === undefined)
      this.id = this.blocker.start("prevent-app-suspension");
    else if (!needed) this.close();
  }
  close() {
    if (this.id !== undefined) this.blocker.stop(this.id);
    this.id = undefined;
  }
}
