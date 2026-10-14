import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createNotifyExtension } from "../extensions/index.ts";
import { APPLESCRIPT, notificationArgs, type Notification } from "../src/macos.ts";
import type { Deliver } from "../src/notification-controller.ts";
import type { PickSound } from "../src/sound-picker.ts";

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;

function harness(t: TestContext, options: {
  platform?: NodeJS.Platform;
  mode?: string;
  deliver?: Deliver;
  settingsPath?: string;
  pickSound?: PickSound;
} = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
  const sent: Notification[] = [];
  const messages: string[] = [];
  let idle = true;
  let pending = false;
  let sessionName: string | undefined;
  const directory = mkdtempSync(join(tmpdir(), "pi-notify-test-"));
  const settingsPath = options.settingsPath ?? join(directory, "pi-notify.json");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const ctx = {
    cwd: "/projects/example",
    mode: options.mode ?? "tui",
    sessionManager: { getSessionName: () => sessionName },
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
    settingsPath,
    pickSound: options.pickSound ?? (async () => undefined),
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
  return { sent, messages, emit, tick, command, settingsPath,
    setSessionName: (value: string | undefined) => { sessionName = value; },
    setIdle: (value: boolean) => { idle = value; },
    setPending: (value: boolean) => { pending = value; },
  };
}

test("AppleScript source is fixed and notification text is passed as literal arguments", () => {
  const title = 'Quotes " \\ and unicode 🐢';
  const body = '\n" & do shell script "touch /tmp/nope"\n-- -e';
  assert.deepEqual(notificationArgs({ title, body }), ["-e", APPLESCRIPT, "--", title, body, "Glass"]);
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
  assert.deepEqual(h.sent, [{ title: "Pi · example", body: "Ready for your next message.", sound: "Glass" }]);
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

test("sound is a literal AppleScript argument, with empty string for silent", () => {
  assert.equal(notificationArgs({ title: "Pi", body: "Ready", sound: null }).at(-1), "");
  assert.equal(notificationArgs({ title: "Pi", body: "Ready", sound: "Ping" }).at(-1), "Ping");
});

test("uses session name when set, otherwise the cwd directory name", async (t) => {
  const h = harness(t);
  h.setSessionName("Fix notification tests 🐢");
  await h.emit("agent_settled");
  await h.tick();
  assert.equal(h.sent[0].title, "Pi · Fix notification tests 🐢");
  h.setSessionName("  ");
  await h.emit("agent_start");
  await h.emit("agent_settled");
  await h.tick();
  assert.equal(h.sent[1].title, "Pi · example");
  h.setSessionName("New session name");
  await h.command("test");
  assert.equal(h.sent[2].title, "Pi · New session name");
});

test("sound commands list, validate, save, and preview preferences", async (t) => {
  const h = harness(t);
  await h.command("sound");
  await h.command("status");
  assert.match(h.messages.at(-1)!, /sound: Glass/);
  await h.command("sound list");
  assert.match(h.messages.at(-1)!, /Glass.*Ping.*none/);
  await h.command("sound pInG");
  assert.deepEqual(JSON.parse(readFileSync(h.settingsPath, "utf8")), { sound: "Ping" });
  await h.command("test");
  assert.equal(h.sent.at(-1)!.sound, "Ping");
  await h.command("sound invalid");
  assert.match(h.messages.at(-1)!, /Unknown sound/);
  await h.command("test");
  assert.equal(h.sent.at(-1)!.sound, "Ping");
  await h.command("sound none");
  await h.command("test");
  assert.equal(h.sent.at(-1)!.sound, null);
  await h.command("status");
  assert.match(h.messages.at(-1)!, /sound: none/);
});

test("saved sound is loaded at session start, including silent", async (t) => {
  const h = harness(t);
  for (const sound of ["Pop", null]) {
    writeFileSync(h.settingsPath, JSON.stringify({ sound }));
    await h.emit("session_start");
    await h.emit("agent_settled");
    await h.tick();
    assert.equal(h.sent.at(-1)!.sound, sound);
  }
});

test("changing sound cancels a pending ping with the old preference", async (t) => {
  const h = harness(t);
  await h.emit("agent_settled");
  await h.command("sound Pop");
  await h.tick();
  assert.equal(h.sent.length, 0);
  await h.emit("agent_start");
  await h.emit("agent_settled");
  await h.tick();
  assert.equal(h.sent[0].sound, "Pop");
});

test("malformed settings warn and fall back without interrupting notification", async (t) => {
  const h = harness(t);
  for (const contents of ["{bad json", "[]", "null", '{"sound":42}', '{"sound":"nonexistent"}']) {
    writeFileSync(h.settingsPath, contents);
    await h.emit("session_start");
    assert.match(h.messages.at(-1)!, /could not read.*using Glass/);
    await h.emit("agent_settled");
    await h.tick();
    assert.equal(h.sent.at(-1)!.sound, "Glass");
  }
});

test("failed sound save leaves the active preference unchanged", async (t) => {
  const h = harness(t);
  await h.emit("session_start");
  mkdirSync(h.settingsPath);
  await h.command("sound Ping");
  assert.match(h.messages.at(-1)!, /could not save sound/);
  await h.command("test");
  assert.equal(h.sent[0].sound, "Glass");
});

for (const selected of ["Ping", null, undefined] as const) {
  test(`sound picker result ${String(selected)} saves only on confirmation`, async (t) => {
    let pickerOpened = false;
    const h = harness(t, { pickSound: async (_ctx, current) => {
      pickerOpened = true;
      assert.equal(current, "Glass");
      return selected;
    } });
    await h.command("sound");
    assert.equal(pickerOpened, true);
    await h.command("test");
    assert.equal(h.sent.at(-1)!.sound, selected === undefined ? "Glass" : selected);
    if (selected !== undefined) {
      assert.deepEqual(JSON.parse(readFileSync(h.settingsPath, "utf8")), { sound: selected });
    } else {
      assert.throws(() => readFileSync(h.settingsPath));
    }
  });
}

test("the sound picker does not trigger its own notification and shutdown cancels it", async (t) => {
  let pickerSignal: AbortSignal | undefined;
  const h = harness(t, { pickSound: (_ctx, _current, signal) => {
    pickerSignal = signal;
    return new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve("Ping"), { once: true });
    });
  } });
  await h.emit("agent_settled");
  const picking = h.command("sound");
  await h.emit("ui_prompt_start");
  await h.emit("agent_settled");
  await h.tick();
  assert.equal(h.sent.length, 0);
  await h.emit("session_shutdown");
  await picking;
  assert.equal(pickerSignal?.aborted, true);
  assert.throws(() => readFileSync(h.settingsPath));
});
