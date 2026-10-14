# pi-notify

Native macOS notifications when [Pi](https://pi.dev) is waiting for you. Uses the built-in AppleScript notification command: no Homebrew utility, compiled helper, runtime npm dependency, or model tool required.

## Requirements

- macOS with notifications enabled for the AppleScript notification sender.
- Pi 1.2.0 or newer with `agent_settled` and `ui_prompt_start` / `ui_prompt_end` extension events.
- Interactive terminal (TUI) mode. Notifications are disabled on other platforms and in RPC, JSON, and print modes.

## Install

Install from GitHub:

```sh
pi install git:github.com/jgpruitt/pi-notify
```

Or install from a local checkout:

```sh
pi install /path/to/pi-notify
```

Restart Pi, or run `/reload` in an existing session. Installation is explicit; creating this repository does not install the extension.

For a one-off development session from this directory:

```sh
pi -e ./extensions/index.ts
```

## Behavior

- **Finished working:** one notification after `agent_settled`, when Pi has no automatic continuation left. Explicitly aborted runs do not notify. This is not based on the lower-level `agent_end` event.
- **Blocking dialog:** one notification when Pi opens an extension confirmation, selection, input, editor, or custom blocking UI prompt. This does not detect arbitrary questions printed by shell subprocesses.
- **One-second grace period:** answering a dialog, submitting input, or starting new agent work cancels a pending ping. Queued messages and a busy agent also suppress completion pings.
- **One ping per waiting episode:** no repeating reminders. No startup ping.
- **Session context:** title is `Pi · <session-name>` when the session is named, otherwise `Pi · <cwd-directory-name>`. Pi's `/name` command can set the session name.
- **Privacy:** body is a fixed readiness or dialog message. Prompt contents, assistant output, session transcripts, and full cwd paths are not sent. The session name or project directory name may be visible on the lock screen; avoid sensitive session names if that matters.
- **Sound:** defaults to `Glass`; choose a built-in sound or silent notifications with `/notify sound`. macOS notification settings and Focus determine whether a banner or sound actually appears.
- **Cleanup:** shutdown, reload, and session replacement cancel pending timers and abort in-flight notification subprocesses. Already posted notifications cannot be recalled.
- **Failures:** notification subprocesses time out after five seconds. Automatic failures produce at most one warning per session and do not interrupt the agent.

Notifications are sent even when the terminal is focused. There is no terminal/tab focus detection, click-to-focus integration, or background service.

## Commands

| Command | Behavior |
| --- | --- |
| `/notify` or `/notify status` | Show current state and backend |
| `/notify test` | Immediately submit a test notification, even when automatic pings are off |
| `/notify off` | Disable automatic pings and cancel pending delivery |
| `/notify on` | Enable automatic pings for future waiting episodes |
| `/notify sound` | Open a sound picker with live previews |
| `/notify sound list` | List built-in sound choices |
| `/notify sound Ping` | Choose and save a sound (case-insensitive) |
| `/notify sound none` | Choose and save silent notifications |

In the picker, the current sound starts highlighted. Use **↑/↓** to move and hear each sound, **Enter** to save, or **Escape** to cancel without changing your preference. **None (silent)** stops playback and can be saved like any other choice. Sound does not play just from opening the picker.

Previews use macOS's built-in `/usr/bin/afplay`, not notification banners. They start after a 150 ms pause in navigation; moving again stops the previous preview so sounds do not pile up. Closing the picker, reloading, or shutting down Pi stops previews. Automatic notification pings are suppressed while the picker is open.

Previews use normal audio playback, so they may be audible even when Focus suppresses actual notifications. Use `/notify test` to check the actual notification banner and sound with your macOS notification settings. Changing sound cancels pending notifications so they do not use the previous sound. `/notify status` shows the saved sound without opening the picker.

Sound is saved in `~/.pi/agent/pi-notify.json` (or `$PI_CODING_AGENT_DIR/pi-notify.json` when overridden), independently of Pi's own settings. It survives reloads and restarts. Other running Pi instances pick it up on their next session start or reload. You can also edit the file directly and reload:

```json
{
  "sound": "Ping"
}
```

Use `"sound": null` for silent notifications. Missing settings default to `Glass`; unreadable or invalid settings produce a warning and fall back to `Glass`.

The on/off preference still lasts only for the current extension runtime; reload or restart restores the default (on). Enabling does not retroactively ping for an already-open dialog.

## macOS setup and troubleshooting

1. Run `/notify test`.
2. If no banner appears, check **System Settings → Notifications** for the AppleScript sender. Depending on the macOS release, its name/icon may be associated with Script Editor or the script runner, rather than Pi. The title inside the notification still says Pi.
3. Allow notifications, choose a banner/alert style, and enable notification sounds if desired.
4. Check Focus / Do Not Disturb and Notification Center. A successful AppleScript exit means submission succeeded, not that macOS displayed a banner or played a sound.

The extension cannot grant permissions, bypass Focus, or reliably detect whether macOS displayed a notification. It runs on the machine hosting Pi; an SSH session on a remote host cannot post to your local Mac through this backend.

## Development

```sh
npm ci
npm run check
```

Tests use Node's built-in test runner and mocked timers; they do not post desktop notifications. TypeScript is checked against Pi 1.2.0. Pi itself loads the source extension without a build step.

Layout:

- `extensions/index.ts`: Pi events and commands.
- `src/notification-controller.ts`: delayed, cancellable, deduplicated waiting episodes.
- `src/macos.ts`: fixed AppleScript executed with literal argument values and no shell.
- `src/settings.ts`: sound validation and atomic preference-file writes.
- `src/sound-picker.ts`: interactive sound selection with save/cancel behavior.
- `src/sound-preview.ts`: debounced, cancellable audio previews.
- `tests/`: event, command, session identity, persistence, picker, preview, privacy, cancellation, and failure coverage.

The Pi package exposes only `extensions/index.ts`. Pi and Pi TUI are host-provided peer dependencies; development copies support type-checking and tests and are not bundled.

## License

MIT.
