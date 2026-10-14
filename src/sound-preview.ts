import { execFile } from "node:child_process";
import type { Sound } from "./settings.ts";

export type PlaySound = (sound: Exclude<Sound, null>, signal: AbortSignal) => Promise<void>;

export const playSound: PlaySound = (sound, signal) => new Promise((resolve, reject) => {
  execFile("/usr/bin/afplay", [`/System/Library/Sounds/${sound}.aiff`], {
    signal,
    timeout: 10_000,
    maxBuffer: 16 * 1024,
  }, (error) => {
    if (error) reject(error);
    else resolve();
  });
});

/** Debounce cursor movement and stop the old sound before previewing another. */
export class SoundPreview {
  private timer?: ReturnType<typeof setTimeout>;
  private request?: AbortController;
  private disposed = false;
  private readonly play: PlaySound;
  private readonly onError: (error: unknown) => void;

  constructor(play: PlaySound, onError: (error: unknown) => void) {
    this.play = play;
    this.onError = onError;
  }

  select(sound: Sound): void {
    this.stop();
    if (this.disposed || sound === null) return;
    const request = new AbortController();
    this.request = request;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void Promise.resolve().then(() => {
        if (!request.signal.aborted) return this.play(sound, request.signal);
      }).catch((error: unknown) => {
        if (!request.signal.aborted) this.onError(error);
      });
    }, 150);
    this.timer.unref();
  }

  private stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.request?.abort();
    this.request = undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }
}
