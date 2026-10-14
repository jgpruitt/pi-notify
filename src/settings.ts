import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const SOUNDS = [
  "Basso", "Blow", "Bottle", "Frog", "Funk", "Glass", "Hero", "Morse",
  "Ping", "Pop", "Purr", "Sosumi", "Submarine", "Tink",
] as const;
export type Sound = typeof SOUNDS[number] | null;
export const DEFAULT_SOUND: Sound = "Glass";

/** Undefined means invalid; null explicitly means silent. */
export function parseSound(value: string): Sound | undefined {
  if (value.toLowerCase() === "none") return null;
  return SOUNDS.find((sound) => sound.toLowerCase() === value.toLowerCase());
}

export function loadSound(path: string): Sound {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_SOUND;
    throw error;
  }
  const settings: unknown = JSON.parse(contents);
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error("Expected a JSON object in pi-notify settings.");
  }
  const value: unknown = (settings as Record<string, unknown>).sound;
  if (value === undefined) return DEFAULT_SOUND;
  if (value === null) return null;
  const sound = typeof value === "string" ? parseSound(value) : undefined;
  if (sound === undefined) throw new Error("Invalid sound in pi-notify settings.");
  return sound;
}

export function saveSound(path: string, sound: Sound): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify({ sound }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}
