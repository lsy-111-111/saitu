import type { DiscoveryFollowupAnswer } from "@/lib/competitions/discovery/contracts";

export type DiscoveryFollowupSaveRequest = {
  browserRecordId: string;
  sessionId: string;
  resumeToken: string;
  editedAt: string;
  answers: DiscoveryFollowupAnswer[];
};

/** Serializes ordinary saves. Page exit may dispatch a newer keepalive write;
 * the server's editedAt fence makes those writes safe in either arrival order. */
export class DiscoveryFollowupSaveQueue {
  private generation = 0;
  private active: Promise<boolean> | null = null;
  private controllers = new Set<AbortController>();

  constructor(private readonly options: {
    pending: () => DiscoveryFollowupSaveRequest | null;
    write: (request: DiscoveryFollowupSaveRequest, signal: AbortSignal, keepalive: boolean) => Promise<void>;
    onError: (error: unknown) => void;
    onBusy: (busy: boolean) => void;
  }) {}

  cancel() {
    this.generation += 1;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.active = null;
    this.options.onBusy(false);
  }

  async flush({ keepalive = false }: { keepalive?: boolean } = {}): Promise<boolean> {
    const generation = this.generation;
    while (generation === this.generation) {
      const pending = this.options.pending();
      if (!pending) return true;
      if (!keepalive && this.active) {
        if (!await this.active) return false;
        continue;
      }
      const controller = new AbortController();
      this.controllers.add(controller);
      this.options.onBusy(true);
      const task = (async () => {
        try {
          await this.options.write(pending, controller.signal, keepalive);
          return generation === this.generation && !controller.signal.aborted;
        } catch (error) {
          if (generation === this.generation && !controller.signal.aborted) {
            const pending = this.options.pending();
            if (generation !== this.generation || controller.signal.aborted) return false;
            if (!pending) return true; // A newer keepalive response already saved it.
            this.options.onError(error);
          }
          return false;
        } finally {
          this.controllers.delete(controller);
          if (generation === this.generation) this.options.onBusy(this.controllers.size > 0);
        }
      })();
      if (!keepalive) this.active = task;
      const saved = await task;
      if (this.active === task) this.active = null;
      if (!saved) return false;
      if (keepalive) return true;
    }
    return false;
  }
}
