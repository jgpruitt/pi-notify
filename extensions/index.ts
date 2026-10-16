import { basename, join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
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
    // Shared by explicit tests and agent tools so off/reload/shutdown abort both.
    const immediateRequests = new Set<AbortController>();
    let run = { notified: false };
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
      for (const request of immediateRequests) request.abort();
      immediateRequests.clear();
      activePicker?.abort();
    };

    pi.on("session_start", (_event, ctx) => {
      cancelAll();
      context = ctx;
      run = { notified: false };
      warned = false;
      settingsLoaded = false;
      if (supported(ctx)) loadSettings(ctx);
    });
    pi.on("session_shutdown", () => {
      cancelAll();
      context = undefined;
      run = { notified: false };
    });
    pi.on("input", () => { controller.cancel(); });
    pi.on("agent_start", () => {
      controller.cancel();
      run = { notified: false };
    });
    pi.on("agent_settled", (event, ctx) => {
      controller.cancel("prompt");
      if (!supported(ctx) || event.aborted || activePicker || run.notified) {
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

    pi.registerTool({
      name: "notify",
      label: "Notify",
      description: "Submit a native macOS notification to the user immediately. Use sparingly for important milestones or actionable blockers, not routine progress. Keep messages brief and omit secrets or sensitive details: text may appear on the lock screen. Requires macOS interactive TUI mode and respects /notify off. Submission does not guarantee a visible banner or sound.",
      parameters: Type.Object({
        message: Type.String({ minLength: 1, description: "Brief notification message; no secrets or sensitive details." }),
      }),
      async execute(_toolCallId, { message }, signal, _onUpdate, ctx) {
        if (!message.trim()) throw new Error("Notification message must not be blank.");
        if (!supported(ctx)) throw new Error("pi-notify requires macOS and interactive TUI mode.");
        if (!controller.enabled) {
          return {
            content: [{ type: "text", text: "Notification not sent: disabled by /notify off." }],
            details: { status: "disabled" },
          };
        }
        loadSettings(ctx);
        const currentRun = run;
        const request = new AbortController();
        const deliverySignal = signal ? AbortSignal.any([signal, request.signal]) : request.signal;
        immediateRequests.add(request);
        try {
          deliverySignal.throwIfAborted();
          await deliver(notice(ctx, message), deliverySignal);
          deliverySignal.throwIfAborted();
          if (run === currentRun) {
            currentRun.notified = true;
            controller.cancel("settled");
          }
          return {
            content: [{ type: "text", text: "Notification submitted to macOS. Display and sound depend on notification permissions and Focus settings." }],
            details: { status: "submitted" },
          };
        } finally {
          immediateRequests.delete(request);
        }
      },
    });

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
          immediateRequests.add(request);
          try {
            await deliver(notice(ctx, "Notifications are working. Pi will ping when it needs you."), request.signal);
            ctx.ui.notify("Test submitted to macOS. If no banner appears, check notification permissions and Focus mode.", "info");
          } catch (error) {
            if (!request.signal.aborted) {
              ctx.ui.notify(`pi-notify test failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
            }
          } finally {
            immediateRequests.delete(request);
          }
        } else {
          ctx.ui.notify("Usage: /notify [test|on|off|status|sound [name|none|list]]", "info");
        }
      },
    });
  };
}

export default createNotifyExtension();
