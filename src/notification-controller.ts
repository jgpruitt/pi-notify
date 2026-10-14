import type { Notification } from "./macos.ts";

export type WaitKind = "settled" | "prompt";
export type Deliver = (notification: Notification, signal: AbortSignal) => Promise<void>;

/** One delayed ping per waiting episode; cancellation also aborts in-flight delivery. */
export class NotificationController {
  enabled = true;
  private episode?: {
    kind: WaitKind;
    timer?: ReturnType<typeof setTimeout>;
    abort: AbortController;
  };

  private readonly deliver: Deliver;
  private readonly onError: (error: unknown) => void;
  private readonly delayMs: number;

  constructor(deliver: Deliver, onError: (error: unknown) => void, delayMs = 1_000) {
    this.deliver = deliver;
    this.onError = onError;
    this.delayMs = delayMs;
  }

  wait(kind: WaitKind, notification: Notification, eligible: () => boolean): void {
    if (!this.enabled || this.episode?.kind === kind) return;
    this.cancel();
    const episode = { kind, abort: new AbortController(), timer: undefined as ReturnType<typeof setTimeout> | undefined };
    this.episode = episode;
    episode.timer = setTimeout(() => {
      episode.timer = undefined;
      if (this.episode !== episode || !this.enabled || !eligible()) return;
      void Promise.resolve().then(() => {
        if (!episode.abort.signal.aborted) return this.deliver(notification, episode.abort.signal);
      }).catch((error: unknown) => {
        if (!episode.abort.signal.aborted) this.onError(error);
      });
    }, this.delayMs);
    episode.timer.unref();
  }

  cancel(kind?: WaitKind): void {
    if (!this.episode || (kind && this.episode.kind !== kind)) return;
    if (this.episode.timer) clearTimeout(this.episode.timer);
    this.episode.abort.abort();
    this.episode = undefined;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.cancel();
  }
}
