import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createNotifyExtension } from "../extensions/index.ts";
import { APPLESCRIPT, notificationArgs, type Notification } from "../src/macos.ts";
import type { Deliver } from "../src/notification-controller.ts";

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;

function harness(t: TestContext, options: {
  platform?: NodeJS.Platform;
  mode?: string;
  deliver?: Deliver;
} = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
  const sent: Notification[] = [];
  const messages: string[] = [];
  let idle = true;
  let pending = false;
  const ctx = {
    cwd: "/projects/example",
    mode: options.mode ?? "tui",
    isIdle: () => idle,
    hasPendingMessages: () => pending,
    ui: { notify: (message: string) => messages.push(message) },
  } as unknown as ExtensionContext;
  const api = {
    on: (name: string, handler: Handler) => { handlers.set(name, handler); },
    registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
      commands.set(name, command);
    },
  } as unknown as ExtensionAPI;
  createNotifyExtension({
    platform: options.platform ?? "darwin",
    deliver: options.deliver ?? (async (notification) => { sent.push(notification); }),
  })(api);
  const emit = async (name: string, event: Record<string, unknown> = {}) => {
    await handlers.get(name)?.(event, ctx);
  };
  const tick = async (ms = 1_000) => {
    t.mock.timers.tick(ms);
    await setImmediate();
  };
  const command = (args: string) => commands.get("notify")!.handler(args, ctx);
  t.after(() => emit("session_shutdown"));
  return { sent, messages, emit, tick, command,
    setIdle: (value: boolean) => { idle = value; },
    setPending: (value: boolean) => { pending = value; },
  };
}

test("AppleScript source is fixed and notification text is passed as literal arguments", () => {
  const title = 'Quotes " \\ and unicode 🐢';
  const body = '\n" & do shell script "touch /tmp/nope"\n-- -e';
  assert.deepEqual(notificationArgs({ title, body }), ["-e", APPLESCRIPT, "--", title, body]);
  assert.ok(!APPLESCRIPT.includes(body));
});

test("startup and low-level agent_end do not ping; settled pings once after grace", async (t) => {
  const h = harness(t);
  await h.emit("session_start");
  await h.emit("agent_end");
  await h.tick();
  assert.equal(h.sent.length, 0);
  await h.emit("agent_settled", { aborted: false });
  await h.tick(999);
  assert.equal(h.sent.length, 0);
  await h.tick(1);
  assert.deepEqual(h.sent, [{ title: "Pi · example", body: "Ready for your next message." }]);
  await h.emit("agent_settled", { aborted: false });
  await h.tick();
  assert.equal(h.sent.length, 1);
  await h.emit("agent_start");
  await h.emit("agent_settled", { aborted: false });
  await h.tick();
  assert.equal(h.sent.length, 2);
});

for (const event of ["input", "agent_start", "session_shutdown", "session_start"]) {
  test(`${event} cancels a pending ping`, async (t) => {
    const h = harness(t);
    await h.emit("agent_settled", { aborted: false });
    await h.emit(event);
    await h.tick();
    assert.equal(h.sent.length, 0);
  });
}

test("answered dialogs do not ping; an unanswered dialog pings while the agent is busy", async (t) => {
  const h = harness(t);
  h.setIdle(false);
  await h.emit("ui_prompt_start", { title: "PRIVATE dialog contents" });
  await h.emit("ui_prompt_end");
  await h.tick();
  assert.equal(h.sent.length, 0);
  await h.emit("ui_prompt_start", { title: "PRIVATE dialog contents" });
  await h.tick();
  assert.equal(h.sent.length, 1);
  assert.ok(!JSON.stringify(h.sent).includes("PRIVATE"));
  await h.emit("ui_prompt_end");
  await h.emit("ui_prompt_start");
  await h.tick();
  assert.equal(h.sent.length, 2);
});

test("dialog closure does not cancel a settled notification", async (t) => {
  const h = harness(t);
  await h.emit("agent_settled", { aborted: false });
  await h.emit("ui_prompt_end");
  await h.tick();
  assert.equal(h.sent.length, 1);
});

test("aborts, busy agents, and queued messages do not ping as settled", async (t) => {
  const h = harness(t);
  await h.emit("agent_settled", { aborted: true });
  await h.tick();
  assert.equal(h.sent.length, 0);
  await h.emit("agent_settled", { aborted: false });
  h.setPending(true);
  await h.tick();
  assert.equal(h.sent.length, 0);
  await h.emit("agent_start");
  h.setPending(false);
  h.setIdle(false);
  await h.emit("agent_settled", { aborted: false });
  await h.tick();
  assert.equal(h.sent.length, 0);
});

for (const options of [{ platform: "linux" as const }, { mode: "rpc" }, { mode: "json" }, { mode: "print" }]) {
  test(`notifications are disabled for ${JSON.stringify(options)}`, async (t) => {
    const h = harness(t, options);
    await h.emit("agent_settled", { aborted: false });
    await h.emit("ui_prompt_start");
    await h.tick();
    await h.command("test");
    assert.equal(h.sent.length, 0);
    assert.match(h.messages[0], /requires macOS/);
  });
}

test("on/off/status/test commands work; test bypasses off and grace", async (t) => {
  const h = harness(t);
  await h.emit("agent_settled", { aborted: false });
  await h.command("off");
  await h.tick();
  assert.equal(h.sent.length, 0);
  await h.emit("ui_prompt_start");
  await h.tick();
  assert.equal(h.sent.length, 0);
  await h.command("status");
  assert.match(h.messages.at(-1)!, /off; AppleScript/);
  await h.command("test");
  assert.equal(h.sent.length, 1);
  await h.command("on");
  await h.emit("agent_start");
  await h.emit("agent_settled", { aborted: false });
  await h.tick();
  assert.equal(h.sent.length, 2);
  await h.command("nonsense");
  assert.match(h.messages.at(-1)!, /Usage:/);
});

test("delivery errors are contained and warn only once per session", async (t) => {
  const h = harness(t, { deliver: async () => { throw new Error("osascript failed"); } });
  await h.emit("session_start");
  for (let i = 0; i < 2; i++) {
    await h.emit("agent_start");
    await h.emit("agent_settled", { aborted: false });
    await h.tick();
  }
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0], /osascript failed/);
  await h.command("test");
  assert.match(h.messages.at(-1)!, /test failed/);
});

test("shutdown aborts an in-flight delivery without warning", async (t) => {
  let signal: AbortSignal | undefined;
  const h = harness(t, { deliver: (_notice, activeSignal) => {
    signal = activeSignal;
    return new Promise<void>((_resolve, reject) => {
      activeSignal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  } });
  await h.emit("agent_settled", { aborted: false });
  await h.tick();
  assert.equal(signal?.aborted, false);
  await h.emit("session_shutdown");
  await setImmediate();
  assert.equal(signal?.aborted, true);
  assert.equal(h.messages.length, 0);
});
