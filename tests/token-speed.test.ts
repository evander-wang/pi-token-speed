import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import tokenSpeed, {
  DEFAULT_CONFIG,
  readConfig,
  resolveConfig,
  TokenSpeedWindow,
} from "../extensions/token-speed.ts";

const BASE = 1_700_000_000_000;

type Handler = (event: any, ctx: any) => unknown;

/** 把配置目录指向临时目录，避免测试读到真实 settings.json；返回该目录路径。 */
function useAgentDir(t: test.TestContext, settings?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-token-speed-"));
  if (settings !== undefined) {
    writeFileSync(join(dir, "settings.json"), JSON.stringify(settings), "utf8");
  }

  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;

  t.after(() => {
    if (previous === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previous;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  return dir;
}

function setup(t: test.TestContext, settings?: unknown) {
  useAgentDir(t, settings);

  const handlers = new Map<string, Handler[]>();
  const statuses: string[] = [];
  const notifications: { message: string; level: string }[] = [];

  const ctx = {
    ui: {
      theme: { fg: (tone: string, text: string) => `<${tone}>${text}` },
      setStatus: (_id: string, text: string) => {
        statuses.push(text);
      },
      notify: (message: string, level: string) => {
        notifications.push({ message, level });
      },
    },
  };

  tokenSpeed({
    on: (name: string, handler: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
  } as any);

  const fire = async (name: string, event: any = {}) => {
    for (const handler of handlers.get(name) ?? []) {
      await handler(event, ctx);
    }
  };

  return { fire, statuses, notifications };
}

function enableMockTime(t: test.TestContext) {
  t.mock.timers.enable({ apis: ["Date", "setInterval"] });
  t.mock.timers.setTime(BASE);
}

function delta(text: string, output = 0) {
  return {
    type: "message_update",
    assistantMessageEvent: {
      type: "text_delta",
      delta: text,
      partial: { usage: { output } },
    },
  } as any;
}

/** 40 个 ASCII 字符 ≈ 10 token。 */
const TEN_TOKENS = "aaaa".repeat(10);

// ---------------------------------------------------------------- 窗口算法

test("窗口：空窗口与过期采样返回 0", () => {
  const window = new TokenSpeedWindow(3000);

  assert.equal(window.rate(BASE), 0);

  window.record(10, BASE);
  assert.equal(window.rate(BASE + 10_000), 0);
});

test("窗口：按窗口内 token 与跨度计算速率", () => {
  const window = new TokenSpeedWindow(3000);

  window.record(1, BASE);
  window.record(1, BASE + 1000);

  // 窗口内 2 token，跨度 1000ms
  assert.equal(window.rate(BASE + 1000), 2);
});

test("窗口：同一时间戳的突发把跨度回溯到上一批采样", () => {
  const window = new TokenSpeedWindow(3000);

  window.record(5, BASE);
  window.record(500, BASE + 6000);

  // 500 token 摊回停顿前的 6000ms，而不是只除以下限 250ms
  assert.equal(window.rate(BASE + 6000), 500 / 6);

  window.reset();
  window.record(500, BASE + 6000);

  // 没有更早的采样时只能受跨度下限约束
  assert.equal(window.rate(BASE + 6000), 2000);
});

// ---------------------------------------------------------------- 配置解析

test("配置：缺失或为 null 时用默认值且不报错", () => {
  for (const raw of [undefined, null]) {
    const { config, errors } = resolveConfig(raw);
    assert.deepEqual(config, DEFAULT_CONFIG);
    assert.deepEqual(errors, []);
  }
});

test("配置：合法值覆盖默认值", () => {
  const { config, errors } = resolveConfig({ windowMs: 1000, refreshIntervalMs: 200 });

  assert.deepEqual(config, { windowMs: 1000, refreshIntervalMs: 200 });
  assert.deepEqual(errors, []);
});

test("配置：非对象、非数字都回退默认并报错", () => {
  const notObject = resolveConfig("nope");
  assert.deepEqual(notObject.config, DEFAULT_CONFIG);
  assert.equal(notObject.errors.length, 1);

  const notNumber = resolveConfig({ windowMs: "3000" });
  assert.deepEqual(notNumber.config, DEFAULT_CONFIG);
  assert.match(notNumber.errors[0] ?? "", /windowMs 必须是数字/);

  const notFinite = resolveConfig({ refreshIntervalMs: Number.NaN });
  assert.deepEqual(notFinite.config, DEFAULT_CONFIG);
  assert.match(notFinite.errors[0] ?? "", /refreshIntervalMs 必须是数字/);
});

test("配置：超范围的值钳到边界并报错", () => {
  const { config, errors } = resolveConfig({ windowMs: 10, refreshIntervalMs: 999_999 });

  assert.deepEqual(config, { windowMs: 500, refreshIntervalMs: 5000 });
  assert.equal(errors.length, 2);
});

test("配置：从 settings.json 读取自己的键，坏文件用默认值", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-token-speed-read-"));
  const path = join(dir, "settings.json");

  try {
    assert.deepEqual(readConfig(path).config, DEFAULT_CONFIG);

    writeFileSync(path, "not json", "utf8");
    const broken = readConfig(path);
    assert.deepEqual(broken.config, DEFAULT_CONFIG);
    assert.deepEqual(broken.errors, []);

    writeFileSync(
      path,
      JSON.stringify({ tokenSpeed: { windowMs: 111 }, piTokenSpeed: { windowMs: 1200 } }),
      "utf8",
    );
    const { config, errors } = readConfig(path);
    // 只认 piTokenSpeed，不去读 npm 同名包的 tokenSpeed 段
    assert.deepEqual(config, { windowMs: 1200, refreshIntervalMs: 500 });
    assert.deepEqual(errors, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("配置：非法值会在会话启动时提示一次", async (t) => {
  const { fire, notifications } = setup(t, { piTokenSpeed: { windowMs: "big" } });

  await fire("session_start");
  await fire("session_start");

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.level, "warning");
  assert.match(notifications[0]?.message ?? "", /piTokenSpeed\.windowMs/);
});

// ---------------------------------------------------------------- 扩展行为

test("扩展：窗口长度可通过配置改变", async (t) => {
  enableMockTime(t);
  const { fire, statuses } = setup(t, { piTokenSpeed: { windowMs: 1000 } });

  await fire("message_start", { message: { role: "assistant" } });
  await fire("message_update", delta(TEN_TOKENS));

  t.mock.timers.tick(1400);
  await fire("message_update", delta(TEN_TOKENS));

  t.mock.timers.tick(600);
  // 1s 窗口只看得到第二批，10 token / 2s = 5
  assert.equal(statuses.at(-1), "<accent>⚡ ~5 tok/s");
});

test("扩展：默认 3s 窗口会把两批都算进来", async (t) => {
  enableMockTime(t);
  const { fire, statuses } = setup(t);

  await fire("message_start", { message: { role: "assistant" } });
  await fire("message_update", delta(TEN_TOKENS));

  t.mock.timers.tick(1400);
  await fire("message_update", delta(TEN_TOKENS));

  t.mock.timers.tick(600);
  // 3s 窗口看到两批，20 token / 2s = 10
  assert.equal(statuses.at(-1), "<accent>⚡ ~10 tok/s");
});

test("扩展：刷新间隔可通过配置改变", async (t) => {
  enableMockTime(t);
  const { fire, statuses } = setup(t, { piTokenSpeed: { refreshIntervalMs: 1000 } });

  await fire("message_start", { message: { role: "assistant" } });
  await fire("message_update", delta(TEN_TOKENS));

  t.mock.timers.tick(500);
  assert.equal(statuses.length, 0);

  t.mock.timers.tick(500);
  assert.equal(statuses.at(-1), "<accent>⚡ ~10 tok/s");
});

test("扩展：流式期间渲染窗口速率，provider 有 usage 后去掉估算标记", async (t) => {
  enableMockTime(t);
  const { fire, statuses } = setup(t);

  await fire("message_start", { message: { role: "assistant" } });
  await fire("message_update", delta("abcd"));

  t.mock.timers.tick(500);
  assert.equal(statuses.at(-1), "<accent>⚡ ~2 tok/s");

  t.mock.timers.tick(500);
  await fire("message_update", delta("a", 50));

  t.mock.timers.tick(500);
  assert.equal(statuses.at(-1), "<accent>⚡ 34 tok/s");
});

test("扩展：工具执行期间暂停计时且不刷新状态栏", async (t) => {
  enableMockTime(t);
  const { fire, statuses } = setup(t);

  await fire("message_start", { message: { role: "assistant" } });
  await fire("message_update", delta("abcd"));

  t.mock.timers.tick(1000);
  const beforeTool = statuses.length;

  await fire("tool_execution_start", { toolCallId: "t1" });
  t.mock.timers.tick(2000);
  assert.equal(statuses.length, beforeTool);

  await fire("tool_execution_end", { toolCallId: "t1" });
  await fire("message_update", delta("abcd"));

  t.mock.timers.tick(500);
  assert.equal(statuses.at(-1), "<accent>⚡ ~2 tok/s");
  assert.ok(statuses.length > beforeTool);
});

test("扩展：agent_end 用 assistant + toolResult 的 usage 总量给出精确速率并停止刷新", async (t) => {
  enableMockTime(t);
  const { fire, statuses } = setup(t);

  await fire("message_start", { message: { role: "assistant" } });
  await fire("message_update", delta("abcd"));
  t.mock.timers.tick(1000);

  await fire("tool_execution_start", { toolCallId: "t1" });
  t.mock.timers.tick(2000);
  await fire("tool_execution_end", { toolCallId: "t1" });

  await fire("agent_end", {
    messages: [
      { role: "assistant", usage: { output: 300 } },
      { role: "user" },
      { role: "toolResult", usage: { output: 100 } },
    ],
  });

  // 总耗时 3000ms 减去 2000ms 工具时间 = 1000ms 生成时间，400 token
  assert.equal(statuses.at(-1), "<success>⚡ 400 tok/s");

  const afterEnd = statuses.length;
  t.mock.timers.tick(5000);
  assert.equal(statuses.length, afterEnd);
});

test("扩展：provider 不报 usage 时退回本地估算", async (t) => {
  enableMockTime(t);
  const { fire, statuses } = setup(t);

  await fire("message_start", { message: { role: "assistant" } });
  await fire("message_update", delta("abcd"));
  t.mock.timers.tick(1000);

  await fire("agent_end", { messages: [{ role: "user" }] });

  // 1 token / 1000ms，带 ~ 标记
  assert.equal(statuses.at(-1), "<muted>⚡ ~1 tok/s");
});

test("扩展：user 消息不会开始计时", async (t) => {
  enableMockTime(t);
  const { fire, statuses } = setup(t);

  await fire("message_start", { message: { role: "user" } });
  await fire("message_update", delta("abcd"));
  t.mock.timers.tick(2000);

  assert.equal(statuses.length, 0);
});
