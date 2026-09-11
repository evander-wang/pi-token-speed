import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const STATUS_ID = "token-speed";

/** 刷新频率：流式期间每 500ms 重算一次，避免每个 delta 都重绘状态栏。 */
const REFRESH_INTERVAL_MS = 500;

/** 耗时太短时速率抖动极大，先把这段时间跳过。 */
const MIN_ELAPSED_MS = 400;

/** CJK / 假名 / 谚文按 1 字符 ≈ 1 token 估算，其余按 4 字符 ≈ 1 token。 */
const WIDE_CHAR =
  /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uff60]/;

function estimateTokens(text: string): number {
  let wide = 0;
  let narrow = 0;

  for (const char of text) {
    if (WIDE_CHAR.test(char)) {
      wide += 1;
    } else {
      narrow += 1;
    }
  }

  return wide + narrow / 4;
}

function formatRate(tokensPerSecond: number): string {
  const rounded = Math.round(tokensPerSecond);
  return rounded === 0 ? "<1" : String(rounded);
}

type LiveMessage = {
  startedAt: number;
  estimatedTokens: number;
  /** provider 流式期间上报的累计 output，多为 0。 */
  reportedOutput: number;
  context: ExtensionContext;
  timer: ReturnType<typeof setInterval> | undefined;
};

export default function (pi: ExtensionAPI) {
  let live: LiveMessage | undefined;

  function render() {
    if (live === undefined) return;

    const elapsedMs = Date.now() - live.startedAt;
    if (elapsedMs < MIN_ELAPSED_MS) return;

    const tokens =
      live.reportedOutput > 0 ? live.reportedOutput : live.estimatedTokens;
    const rate = tokens / (elapsedMs / 1000);

    live.context.ui.setStatus(
      STATUS_ID,
      live.context.ui.theme.fg("accent", `⚡ ~${formatRate(rate)} tok/s`),
    );
  }

  function stopLive() {
    if (live?.timer !== undefined) {
      clearInterval(live.timer);
    }
    live = undefined;
  }

  pi.on("message_start", async (event, ctx) => {
    if (event.message.role !== "assistant") return;

    stopLive();

    live = {
      startedAt: Date.now(),
      estimatedTokens: 0,
      reportedOutput: 0,
      context: ctx,
      timer: undefined,
    };

    live.timer = setInterval(render, REFRESH_INTERVAL_MS);
  });

  pi.on("message_update", async (event, ctx) => {
    if (live === undefined) return;

    live.context = ctx;

    const streamEvent = event.assistantMessageEvent;
    switch (streamEvent.type) {
      case "text_delta":
      case "thinking_delta":
      case "toolcall_delta":
        live.estimatedTokens += estimateTokens(streamEvent.delta);
        break;
      default:
        break;
    }

    if (
      event.message.role === "assistant" &&
      event.message.usage.output > 0
    ) {
      live.reportedOutput = event.message.usage.output;
    }
  });

  pi.on("message_end", async (event, ctx) => {
    if (live === undefined || event.message.role !== "assistant") return;

    const elapsedMs = Date.now() - live.startedAt;
    const { usage } = event.message;
    const exact = usage.output > 0 && elapsedMs > 0;
    const tokens = exact ? usage.output : live.estimatedTokens;
    const rate = elapsedMs > 0 ? tokens / (elapsedMs / 1000) : 0;

    stopLive();

    if (exact) {
      ctx.ui.setStatus(
        STATUS_ID,
        ctx.ui.theme.fg("success", `⚡ ${formatRate(rate)} tok/s`),
      );
      return;
    }

    if (elapsedMs >= MIN_ELAPSED_MS) {
      ctx.ui.setStatus(
        STATUS_ID,
        ctx.ui.theme.fg("muted", `⚡ ~${formatRate(rate)} tok/s`),
      );
    }
  });

  pi.on("session_shutdown", async () => {
    stopLive();
  });
}
