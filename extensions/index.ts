import { basename, join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SOUND, SOUNDS, loadSound, parseSound, saveSound, type Sound } from "../src/settings.ts";
import { notifyMacOS, type Notification } from "../src/macos.ts";
import { NotificationController, type Deliver } from "../src/notification-controller.ts";
import { pickSound, type PickSound } from "../src/sound-picker.ts";

// Dependency injection keeps tests independent of macOS and Notification Center.
export function createNotifyExtension(options: {
  platform?: NodeJS.Platform;
  deliver?: Deliver;
  delayMs?: number;
  settingsPath?: string;
  pickSound?: PickSound;
} = {}) {
  return function (pi: ExtensionAPI): void {
    const platform = options.platform ?? process.platform;
    const deliver = options.deliver ?? notifyMacOS;
    let context: ExtensionContext | undefined;
    let warned = false;
    let sound: Sound = DEFAULT_SOUND;
    let settingsLoaded = false;
    const settingsPath = options.settingsPath ?? join(getAgentDir(), "pi-notify.json");
    const loadSettings = (ctx: ExtensionContext) => {
      if (settingsLoaded) return;
      settingsLoaded = true;
      sound = DEFAULT_SOUND;
      try {
        sound = loadSound(settingsPath);
      } catch (error) {
        ctx.ui.notify(`pi-notify: could not read ${settingsPath}; using Glass. ${error instanceof Error ? error.message : String(error)}`, "warning");
      }
    };
    const testRequests = new Set<AbortController>();
    let activePicker: AbortController | undefined;
    const supported = (ctx: ExtensionContext) => platform === "darwin" && ctx.mode === "tui";
    const notice = (ctx: ExtensionContext, body: string): Notification => ({
      title: `Pi · ${ctx.sessionManager.getSessionName()?.trim() || basename(ctx.cwd) || ctx.cwd}`,
      body,
      sound,
    });
    const controller = new NotificationController(deliver, (error) => {
      if (warned) return;
      warned = true;
      const message = error instanceof Error ? error.message : String(error);
      context?.ui.notify(`pi-notify: could not send a macOS notification: ${message}`, "warning");
    }, options.delayMs);
    const cancelAll = () => {
      controller.cancel();
      for (const request of testRequests) request.abort();
      testRequests.clear();
      activePicker?.abort();
    };

    pi.on("session_start", (_event, ctx) => {
      cancelAll();
      context = ctx;
      warned = false;
      settingsLoaded = false;
      if (supported(ctx)) loadSettings(ctx);
    });
    pi.on("session_shutdown", () => {
      cancelAll();
      context = undefined;
    });
    pi.on("input", () => { controller.cancel(); });
    pi.on("agent_start", () => { controller.cancel(); });
    pi.on("agent_settled", (event, ctx) => {
      controller.cancel("prompt");
      if (!supported(ctx) || event.aborted || activePicker) {
        controller.cancel();
        return;
      }
      context = ctx;
      loadSettings(ctx);
      controller.wait("settled", notice(ctx, "Ready for your next message."),
        () => ctx.isIdle() && !ctx.hasPendingMessages());
    });
    pi.on("ui_prompt_start", (_event, ctx) => {
      if (!supported(ctx) || activePicker) return;
      context = ctx;
      loadSettings(ctx);
      controller.wait("prompt", notice(ctx, "Waiting for your response to a dialog."), () => true);
    });
    pi.on("ui_prompt_end", () => { controller.cancel("prompt"); });

    pi.registerCommand("notify", {
      description: "macOS notifications: test, on, off, status, sound [name|none|list]",
      handler: async (args, ctx) => {
        const command = args.trim() || "status";
        if (!supported(ctx)) {
          ctx.ui.notify("pi-notify requires macOS and interactive TUI mode.", "warning");
          return;
        }
        loadSettings(ctx);
        if (command === "sound" || command.startsWith("sound ")) {
          const value = command.slice("sound".length).trim();
          if (value.toLowerCase() === "list") {
            ctx.ui.notify(`Sounds: ${SOUNDS.join(", ")}, none (silent).`, "info");
            return;
          }
          let selected: Sound | undefined;
          if (!value) {
            if (activePicker) return;
            controller.cancel();
            const request = new AbortController();
            activePicker = request;
            try {
              selected = await (options.pickSound ?? pickSound)(ctx, sound, request.signal);
              if (request.signal.aborted) return;
            } catch (error) {
              if (!request.signal.aborted) {
                ctx.ui.notify(`pi-notify: could not open sound picker: ${error instanceof Error ? error.message : String(error)}`, "warning");
              }
              return;
            } finally {
              if (activePicker === request) activePicker = undefined;
            }
            if (selected === undefined) return;
          } else {
            selected = parseSound(value);
            if (selected === undefined) {
              ctx.ui.notify("Unknown sound. Use /notify sound list to see available sounds.", "warning");
              return;
            }
          }
          try {
            saveSound(settingsPath, selected);
            sound = selected;
            cancelAll();
            ctx.ui.notify(`pi-notify sound: ${sound ?? "none"} (saved). Use /notify test to preview.`, "info");
          } catch (error) {
            ctx.ui.notify(`pi-notify: could not save sound: ${error instanceof Error ? error.message : String(error)}`, "warning");
          }
        } else if (command === "on" || command === "off") {
          controller.setEnabled(command === "on");
          if (command === "off") cancelAll();
          ctx.ui.notify(`pi-notify: ${command} (this extension runtime only).`, "info");
        } else if (command === "status") {
          ctx.ui.notify(`pi-notify: ${controller.enabled ? "on" : "off"}; AppleScript; sound: ${sound ?? "none"}; grace period: 1 second.`, "info");
        } else if (command === "test") {
          const request = new AbortController();
          testRequests.add(request);
          try {
            await deliver(notice(ctx, "Notifications are working. Pi will ping when it needs you."), request.signal);
            ctx.ui.notify("Test submitted to macOS. If no banner appears, check notification permissions and Focus mode.", "info");
          } catch (error) {
            if (!request.signal.aborted) {
              ctx.ui.notify(`pi-notify test failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
            }
          } finally {
            testRequests.delete(request);
          }
        } else {
          ctx.ui.notify("Usage: /notify [test|on|off|status|sound [name|none|list]]", "info");
        }
      },
    });
  };
}

export default createNotifyExtension();
