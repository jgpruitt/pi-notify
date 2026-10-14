import { execFile } from "node:child_process";

export interface Notification {
  title: string;
  body: string;
}

// All variable text is passed as argv, never interpolated into source code.
export const APPLESCRIPT = `on run argv
  display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"
end run`;

export function notificationArgs(notification: Notification): string[] {
  return ["-e", APPLESCRIPT, "--", notification.title, notification.body];
}

export function notifyMacOS(notification: Notification, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/osascript", notificationArgs(notification), {
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      signal,
    }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
