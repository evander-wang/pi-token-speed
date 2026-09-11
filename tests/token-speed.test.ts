import assert from "node:assert/strict";
import test from "node:test";

import tokenSpeed, { TokenSpeedWindow } from "../extensions/token-speed.ts";

const BASE = 1_700_000_000_000;

type Handler = (event: any, ctx: any) => unknown;

function setup() {
  const handlers = new Map<string, Handler[]>();
  const statuses: string[] = [];

  const ctx = {
    ui: {
      theme: { fg: (tone: string, text: string) => `<${tone}>${text}` },
      setStatus: (_id: string, text: string) => {
        statuses.push(text);
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

  return { fire, statuses };
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

test("扩展：流式期间渲染窗口速率，provider 有 usage 后去掉估算标记", async (t) => {
  enableMockTime(t);
  const { fire, statuses } = setup();

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
  const { fire, statuses } = setup();

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
  const { fire, statuses } = setup();

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
  const { fire, statuses } = setup();

  await fire("message_start", { message: { role: "assistant" } });
  await fire("message_update", delta("abcd"));
  t.mock.timers.tick(1000);

  await fire("agent_end", { messages: [{ role: "user" }] });

  // 1 token / 1000ms，带 ~ 标记
  assert.equal(statuses.at(-1), "<muted>⚡ ~1 tok/s");
});

test("扩展：user 消息不会开始计时", async (t) => {
  enableMockTime(t);
  const { fire, statuses } = setup();

  await fire("message_start", { message: { role: "user" } });
  await fire("message_update", delta("abcd"));
  t.mock.timers.tick(2000);

  assert.equal(statuses.length, 0);
});
