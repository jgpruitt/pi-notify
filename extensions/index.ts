import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { notifyMacOS, type Notification } from "../src/macos.ts";
import { NotificationController, type Deliver } from "../src/notification-controller.ts";

// Dependency injection keeps tests independent of macOS and Notification Center.
export function createNotifyExtension(options: {
  platform?: NodeJS.Platform;
  deliver?: Deliver;
  delayMs?: number;
} = {}) {
  return function (pi: ExtensionAPI): void {
    const platform = options.platform ?? process.platform;
    const deliver = options.deliver ?? notifyMacOS;
    let context: ExtensionContext | undefined;
    let warned = false;
    const testRequests = new Set<AbortController>();
    const supported = (ctx: ExtensionContext) => platform === "darwin" && ctx.mode === "tui";
    const notice = (ctx: ExtensionContext, body: string): Notification => ({
      title: `Pi · ${basename(ctx.cwd) || ctx.cwd}`,
      body,
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
    };

    pi.on("session_start", (_event, ctx) => {
      cancelAll();
      context = ctx;
      warned = false;
    });
    pi.on("session_shutdown", () => {
      cancelAll();
      context = undefined;
    });
    pi.on("input", () => { controller.cancel(); });
    pi.on("agent_start", () => { controller.cancel(); });
    pi.on("agent_settled", (event, ctx) => {
      controller.cancel("prompt");
      if (!supported(ctx) || event.aborted) {
        controller.cancel();
        return;
      }
      context = ctx;
      controller.wait("settled", notice(ctx, "Ready for your next message."),
        () => ctx.isIdle() && !ctx.hasPendingMessages());
    });
    pi.on("ui_prompt_start", (_event, ctx) => {
      if (!supported(ctx)) return;
      context = ctx;
      controller.wait("prompt", notice(ctx, "Waiting for your response to a dialog."), () => true);
    });
    pi.on("ui_prompt_end", () => { controller.cancel("prompt"); });

    pi.registerCommand("notify", {
      description: "macOS notifications: test, on, off, status",
      handler: async (args, ctx) => {
        const command = args.trim() || "status";
        if (!supported(ctx)) {
          ctx.ui.notify("pi-notify requires macOS and interactive TUI mode.", "warning");
          return;
        }
        if (command === "on" || command === "off") {
          controller.setEnabled(command === "on");
          if (command === "off") cancelAll();
          ctx.ui.notify(`pi-notify: ${command} (this extension runtime only).`, "info");
        } else if (command === "status") {
          ctx.ui.notify(`pi-notify: ${controller.enabled ? "on" : "off"}; AppleScript; sound: Glass; grace period: 1 second.`, "info");
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
          ctx.ui.notify("Usage: /notify [test|on|off|status]", "info");
        }
      },
    });
  };
}

export default createNotifyExtension();
