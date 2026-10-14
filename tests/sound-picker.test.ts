import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createSoundPicker } from "../src/sound-picker.ts";
import { SoundPreview, type PlaySound } from "../src/sound-preview.ts";
import type { Sound } from "../src/settings.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;
const tui = { requestRender() {} };

test("previews debounce fast movement and stop on silent/disposal", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const played: string[] = [];
  const signals: AbortSignal[] = [];
  const preview = new SoundPreview(async (sound, signal) => {
    played.push(sound);
    signals.push(signal);
  }, (error) => assert.fail(String(error)));
  t.after(() => preview.dispose());
  preview.select("Glass");
  t.mock.timers.tick(100);
  preview.select("Ping");
  t.mock.timers.tick(149);
  await setImmediate();
  assert.deepEqual(played, []);
  t.mock.timers.tick(1);
  await setImmediate();
  assert.deepEqual(played, ["Ping"]);
  preview.select("Pop");
  assert.equal(signals[0].aborted, true);
  preview.select(null);
  t.mock.timers.tick(200);
  await setImmediate();
  assert.deepEqual(played, ["Ping"]);
  preview.select("Glass");
  t.mock.timers.tick(150);
  await setImmediate();
  assert.equal(signals.at(-1)!.aborted, false);
  preview.dispose();
  assert.equal(signals.at(-1)!.aborted, true);
  preview.select("Ping");
  t.mock.timers.tick(200);
  await setImmediate();
  assert.deepEqual(played, ["Ping", "Glass"]);
});

test("preview errors are contained and cancellation is not an error", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const errors: unknown[] = [];
  const preview = new SoundPreview(async (_sound, signal) => {
    await setImmediate();
    if (signal.aborted) throw new Error("aborted");
    throw new Error("audio unavailable");
  }, (error) => errors.push(error));
  t.after(() => preview.dispose());
  preview.select("Ping");
  t.mock.timers.tick(150);
  await setImmediate();
  await setImmediate();
  assert.equal(errors.length, 1);
  preview.select("Glass");
  t.mock.timers.tick(150);
  await Promise.resolve();
  preview.dispose();
  await setImmediate();
  assert.equal(errors.length, 1);
});

test("picker highlights current sound, previews movement, and Enter confirms", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const played: string[] = [];
  const signals: AbortSignal[] = [];
  const results: (Sound | undefined)[] = [];
  const picker = createSoundPicker(tui, theme, "Glass", (value) => results.push(value), new AbortController().signal,
    async (sound, signal) => { played.push(sound); signals.push(signal); });
  t.after(() => picker.dispose());
  assert.match(picker.render(80).join("\n"), /→ Glass/);
  assert.deepEqual(played, []);
  picker.handleInput!("\u001b[B"); // down: Hero
  t.mock.timers.tick(150);
  await setImmediate();
  assert.deepEqual(played, ["Hero"]);
  assert.deepEqual(results, []);
  picker.handleInput!("\r");
  assert.deepEqual(results, ["Hero"]);
  assert.equal(signals[0].aborted, true);
  picker.handleInput!("\r");
  assert.deepEqual(results, ["Hero"]);
});

test("Escape cancels and stops a pending preview", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const results: (Sound | undefined)[] = [];
  const played: string[] = [];
  const picker = createSoundPicker(tui, theme, "Ping", (value) => results.push(value), new AbortController().signal,
    async (sound) => { played.push(sound); });
  picker.handleInput!("\u001b[B");
  picker.handleInput!("\u001b");
  t.mock.timers.tick(200);
  await setImmediate();
  assert.deepEqual(results, [undefined]);
  assert.deepEqual(played, []);
});

test("silent is selectable and moving to it stops playback", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let playbackSignal: AbortSignal | undefined;
  const results: (Sound | undefined)[] = [];
  const picker = createSoundPicker(tui, theme, "Tink", (value) => results.push(value), new AbortController().signal,
    async (_sound, signal) => { playbackSignal = signal; });
  // Move away and back to trigger a Tink preview.
  picker.handleInput!("\u001b[A");
  picker.handleInput!("\u001b[B");
  t.mock.timers.tick(150);
  await setImmediate();
  assert.equal(playbackSignal?.aborted, false);
  picker.handleInput!("\u001b[B"); // none
  assert.equal(playbackSignal?.aborted, true);
  picker.handleInput!("\r");
  assert.deepEqual(results, [null]);
});

test("shutdown abort closes picker and cancels previews", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const request = new AbortController();
  const results: (Sound | undefined)[] = [];
  const played: string[] = [];
  const picker = createSoundPicker(tui, theme, null, (value) => results.push(value), request.signal,
    async (sound) => { played.push(sound); });
  picker.handleInput!("\u001b[A");
  request.abort();
  t.mock.timers.tick(200);
  await setImmediate();
  assert.deepEqual(results, [undefined]);
  assert.deepEqual(played, []);
});

test("picker fits narrow widths and remains usable after preview failure", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const results: (Sound | undefined)[] = [];
  const fail: PlaySound = async () => { throw new Error("no audio device"); };
  const picker = createSoundPicker(tui, theme, "Glass", (value) => results.push(value), new AbortController().signal, fail);
  t.after(() => picker.dispose());
  picker.handleInput!("\u001b[B");
  t.mock.timers.tick(150);
  await setImmediate();
  assert.match(picker.render(80).join("\n"), /Preview unavailable/);
  for (const width of [1, 2, 5, 10, 20, 80]) {
    assert.ok(picker.render(width).every((line) => visibleWidth(line) <= width), `width ${width}`);
  }
  picker.invalidate();
  picker.handleInput!("\r");
  assert.deepEqual(results, ["Hero"]);
});
