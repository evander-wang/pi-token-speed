import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const STATUS_ID = "token-speed";

/** 刷新频率：流式期间每 500ms 重算一次，避免每个 delta 都重绘状态栏。 */
const REFRESH_INTERVAL_MS = 500;

/** 耗时太短时速率抖动极大，先把这段时间跳过。 */
const MIN_ELAPSED_MS = 400;

/** 瞬时速率只看最近 3s：够长能扛住抖动，够短能反映「现在」的速度。 */
const WINDOW_MS = 3000;

/** 窗口跨度下限：provider 把一批 delta 压进同一毫秒时，避免除数趋近 0 刷出天价速率。 */
const MIN_SPAN_MS = 250;

/** 采样数组里的死数据攒到这个长度才压缩一次，避免每个 delta 都搬数组。 */
const COMPACT_THRESHOLD = 512;

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

type Sample = { at: number; tokens: number };

/**
 * 时间滑动窗口：记录 (时刻, token 数) 采样，用最近 windowMs 内的采样算瞬时速率。
 *
 * 停顿后的突发会失真：provider 缓冲过的 delta 会一次性 flush，这些采样时间戳完全相同，
 * 用 now - 首个采样 当分母会算出天价速率（500 token / 250ms = 2000 tok/s）。
 * 检测到整批同一时间戳时，把分母回溯到上一批采样之前，让窗口外的停顿时间也参与平均。
 */
export class TokenSpeedWindow {
  private samples: Sample[] = [];
  private startIndex = 0;
  private readonly windowMs: number;

  // 不用参数属性写法：Node 的 strip-only TS 模式不支持，测试没法直接跑这个文件。
  constructor(windowMs: number = WINDOW_MS) {
    this.windowMs = windowMs;
  }

  record(tokens: number, at: number): void {
    this.samples.push({ at, tokens });

    if (this.startIndex >= COMPACT_THRESHOLD) this.compact();
  }

  /** 窗口内 token 数 / 实际跨度；窗口为空返回 0。 */
  rate(now: number): number {
    if (this.samples.length === 0) return 0;

    const windowStart = now - this.windowMs;
    while (
      this.startIndex < this.samples.length &&
      this.samples[this.startIndex].at < windowStart
    ) {
      this.startIndex += 1;
    }

    if (this.startIndex >= this.samples.length) return 0;

    let tokens = 0;
    for (let i = this.startIndex; i < this.samples.length; i += 1) {
      tokens += this.samples[i].tokens;
    }
    if (tokens === 0) return 0;

    const first = this.samples[this.startIndex].at;
    const last = this.samples[this.samples.length - 1].at;
    const spanStart =
      first === last && this.startIndex > 0
        ? this.samples[this.startIndex - 1].at
        : first;
    const span = Math.max(now - spanStart, MIN_SPAN_MS);

    return (1000 * tokens) / span;
  }

  reset(): void {
    this.samples = [];
    this.startIndex = 0;
  }

  private compact(): void {
    if (this.startIndex === 0) return;
    this.samples.splice(0, this.startIndex);
    this.startIndex = 0;
  }
}

type Run = {
  live: boolean;
  startedAt: number;
  endedAt: number;
  /** 工具执行等非生成时间，从耗时里剔除，不参与速率分母。 */
  pausedMs: number;
  pauseStartedAt: number | undefined;
  /** 并行工具模式下可能同时有多个工具在跑，全部结束才算恢复。 */
  activeTools: Set<string>;
  estimatedTokens: number;
  /** 已计入的 provider 累计 output，只取增量，避免重复累计。 */
  countedOutput: number;
  /** provider 最近一次上报的累计 output，>0 说明当前速率不再是纯估算。 */
  reportedOutput: number;
  context: ExtensionContext;
  timer: ReturnType<typeof setInterval> | undefined;
  window: TokenSpeedWindow;
};

/** 剔除暂停时间后的实际生成耗时。 */
function elapsedMs(run: Run, now: number): number {
  const end = run.live ? now : run.endedAt;
  const openPause =
    run.pauseStartedAt === undefined ? 0 : Math.max(end - run.pauseStartedAt, 0);
  return Math.max(end - run.startedAt - run.pausedMs - openPause, 0);
}

export default function (pi: ExtensionAPI) {
  let run: Run | undefined;

  function render() {
    if (run === undefined || !run.live || run.pauseStartedAt !== undefined) return;

    const now = Date.now();
    if (elapsedMs(run, now) < MIN_ELAPSED_MS) return;

    const rate = run.window.rate(now);
    const approximate = run.reportedOutput === 0;
    run.context.ui.setStatus(
      STATUS_ID,
      run.context.ui.theme.fg(
        "accent",
        `⚡ ${approximate ? "~" : ""}${formatRate(rate)} tok/s`,
      ),
    );
  }

  function stopTimer() {
    if (run?.timer !== undefined) {
      clearInterval(run.timer);
      run.timer = undefined;
    }
  }

  function endRun(now: number) {
    if (run === undefined) return;

    if (run.pauseStartedAt !== undefined) {
      run.pausedMs += Math.max(now - run.pauseStartedAt, 0);
      run.pauseStartedAt = undefined;
    }
    run.endedAt = now;
    run.live = false;
    run.activeTools.clear();
    stopTimer();
  }

  function startRun(context: ExtensionContext) {
    stopTimer();
    run = {
      live: true,
      startedAt: Date.now(),
      endedAt: 0,
      pausedMs: 0,
      pauseStartedAt: undefined,
      activeTools: new Set(),
      estimatedTokens: 0,
      countedOutput: 0,
      reportedOutput: 0,
      context,
      timer: undefined,
      window: new TokenSpeedWindow(),
    };
    run.timer = setInterval(render, REFRESH_INTERVAL_MS);
  }

  function recordDelta(delta: string, usageOutput: number) {
    if (run === undefined) return;

    let tokens = 0;
    if (usageOutput > run.countedOutput) {
      tokens = usageOutput - run.countedOutput;
      run.countedOutput = usageOutput;
      run.reportedOutput = usageOutput;
    } else {
      tokens = estimateTokens(delta);
    }
    if (tokens <= 0) return;

    run.estimatedTokens += tokens;
    run.window.record(tokens, Date.now());
  }

  pi.on("message_start", async (event, ctx) => {
    if (event.message.role !== "assistant") return;

    // 一次 agent 运行可能有多条 assistant 消息（中间夹着工具调用），
    // 只有没有进行中的运行时才重新开始计时。
    if (run === undefined || !run.live) {
      startRun(ctx);
    } else {
      run.context = ctx;
    }
  });

  pi.on("message_update", async (event, ctx) => {
    if (run === undefined || !run.live) return;

    run.context = ctx;

    const streamEvent = event.assistantMessageEvent;
    switch (streamEvent.type) {
      case "text_delta":
      case "thinking_delta":
      case "toolcall_delta":
        recordDelta(streamEvent.delta, streamEvent.partial.usage.output);
        break;
      default:
        break;
    }
  });

  pi.on("tool_execution_start", async (event) => {
    if (run === undefined || !run.live) return;

    run.activeTools.add(event.toolCallId);
    if (run.pauseStartedAt === undefined) {
      run.pauseStartedAt = Date.now();
    }
  });

  pi.on("tool_execution_end", async (event) => {
    if (run === undefined || !run.live || run.pauseStartedAt === undefined) return;

    run.activeTools.delete(event.toolCallId);
    if (run.activeTools.size > 0) return;

    // 工具耗时不算生成时间，恢复时把这段补进 pausedMs。
    // 同时丢掉暂停前的窗口采样：它们描述的是工具之前那一段的生成速度，
    // 留着会把恢复后的瞬时速率和一段什么都没生成的间隙混在一起。
    run.pausedMs += Math.max(Date.now() - run.pauseStartedAt, 0);
    run.pauseStartedAt = undefined;
    run.window.reset();
  });

  pi.on("agent_end", async (event, ctx) => {
    if (run === undefined || !run.live) return;

    const now = Date.now();
    endRun(now);
    run.context = ctx;

    // 用本次运行所有消息的 usage 汇总，替掉流式期间的本地估算：
    // assistant 消息和 toolResult 消息都带 output。
    const total = event.messages.reduce((sum, message) => {
      if (message.role === "assistant") return sum + message.usage.output;
      if (message.role === "toolResult") return sum + (message.usage?.output ?? 0);
      return sum;
    }, 0);

    // provider 完全不报 usage 时退回本地估算，至少给个带 ~ 的参考值。
    const exact = total > 0;
    const tokens = exact ? total : run.estimatedTokens;
    const elapsed = elapsedMs(run, now);
    if (tokens <= 0 || elapsed < MIN_ELAPSED_MS) return;

    ctx.ui.setStatus(
      STATUS_ID,
      ctx.ui.theme.fg(
        exact ? "success" : "muted",
        `⚡ ${exact ? "" : "~"}${formatRate(tokens / (elapsed / 1000))} tok/s`,
      ),
    );
  });

  pi.on("session_shutdown", async () => {
    if (run === undefined) return;

    endRun(Date.now());
    run = undefined;
  });
}
