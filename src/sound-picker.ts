import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { SelectList, Text, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { SOUNDS, parseSound, type Sound } from "./settings.ts";
import { playSound, SoundPreview, type PlaySound } from "./sound-preview.ts";

export type PickSound = (ctx: ExtensionContext, current: Sound, signal: AbortSignal) => Promise<Sound | undefined>;

export function createSoundPicker(
  tui: Pick<TUI, "requestRender">,
  theme: Theme,
  current: Sound,
  done: (sound: Sound | undefined) => void,
  signal: AbortSignal,
  play: PlaySound = playSound,
): Component & { dispose(): void } {
  let closed = false;
  let previewError = "";
  const items = [
    ...SOUNDS.map((sound) => ({ value: sound, label: sound, description: sound === current ? "current" : "" })),
    { value: "none", label: "None (silent)", description: current === null ? "current" : "" },
  ];
  const list = new SelectList(items, 8, {
    selectedPrefix: (text) => theme.fg("accent", text),
    selectedText: (text) => theme.fg("accent", text),
    description: (text) => theme.fg("muted", text),
    scrollInfo: (text) => theme.fg("dim", text),
    noMatch: (text) => theme.fg("warning", text),
  });
  list.setSelectedIndex(items.findIndex((item) => item.value === (current ?? "none")));
  const preview = new SoundPreview(play, () => {
    previewError = "Preview unavailable. You can still save a sound.";
    tui.requestRender();
  });
  const dispose = () => {
    closed = true;
    preview.dispose();
    signal.removeEventListener("abort", onAbort);
  };
  const finish = (sound: Sound | undefined) => {
    if (closed) return;
    dispose();
    done(sound);
  };
  const onAbort = () => finish(undefined);
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) queueMicrotask(onAbort);
  list.onSelectionChange = (item) => {
    const sound = parseSound(item.value);
    if (sound !== undefined) preview.select(sound);
  };
  list.onSelect = (item) => finish(parseSound(item.value));
  list.onCancel = () => finish(undefined);

  return {
    render(width) {
      return [
        ...new Text(theme.fg("accent", theme.bold("Notification sound")), 0, 0).render(width),
        "",
        ...list.render(width),
        "",
        ...new Text(theme.fg("dim", "↑↓ preview · enter save · esc cancel"), 0, 0).render(width),
        ...(previewError ? new Text(theme.fg("warning", previewError), 0, 0).render(width) : []),
      ].map((line) => truncateToWidth(line, width));
    },
    invalidate() { list.invalidate(); },
    handleInput(data) {
      if (closed) return;
      list.handleInput(data);
      tui.requestRender();
    },
    dispose,
  };
}

export const pickSound: PickSound = (ctx, current, signal) => ctx.ui.custom<Sound | undefined>(
  (tui, theme, _keybindings, done) => createSoundPicker(tui, theme, current, done, signal),
);
