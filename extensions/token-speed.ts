import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const STATUS_ID = "token-speed";

/**
 * settings.json 里读配置的键。
 * 故意不叫 `tokenSpeed`：npm 上的同名包 pi-token-speed 用的是那个键，两个都装会撞车。
 */
const SETTINGS_KEY = "piTokenSpeed";

export type TokenSpeedConfig = {
  /** 瞬时速率的滑动窗口，毫秒。 */
  windowMs: number;
  /** 状态栏刷新间隔，毫秒。 */
  refreshIntervalMs: number;
};

export const DEFAULT_CONFIG: TokenSpeedConfig = {
  windowMs: 3000,
  refreshIntervalMs: 500,
};

const LIMITS: Record<keyof TokenSpeedConfig, { min: number; max: number }> = {
  windowMs: { min: 500, max: 30000 },
  refreshIntervalMs: { min: 100, max: 5000 },
};

/** 耗时太短时速率抖动极大，先把这段时间跳过。 */
const MIN_ELAPSED_MS = 400;

/** 窗口跨度下限：provider 把一批 delta 压进同一毫秒时，避免除数趋近 0 刷出天价速率。 */
const MIN_SPAN_MS = 250;

/** 采样数组里的死数据攒到这个长度才压缩一次，避免每个 delta 都搬数组。 */
const COMPACT_THRESHOLD = 512;

/** CJK / 假名 / 谚文按 1 字符 ≈ 1 token 估算，其余按 4 字符 ≈ 1 token。 */
const WIDE_CHAR =
  /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uff60]/;

/**
 * 校验外部配置：缺省用默认值，类型非法回退默认值并给出提示，数值超范围钳到边界。
 * 纯函数，不碰文件系统，方便单测。
 */
export function resolveConfig(raw: unknown): {
  config: TokenSpeedConfig;
  errors: string[];
} {
  const config: TokenSpeedConfig = { ...DEFAULT_CONFIG };
  const errors: string[] = [];

  if (raw === undefined || raw === null) return { config, errors };

  if (typeof raw !== "object" || Array.isArray(raw)) {
    return {
      config,
      errors: [`settings.json 里的 "${SETTINGS_KEY}" 必须是对象，已全部使用默认值`],
    };
  }

  for (const key of Object.keys(DEFAULT_CONFIG) as (keyof TokenSpeedConfig)[]) {
    const value = (raw as Record<string, unknown>)[key];
    if (value === undefined) continue;

    if (typeof value !== "number" || !Number.isFinite(value)) {
      errors.push(
        `${SETTINGS_KEY}.${key} 必须是数字，已用默认值 ${DEFAULT_CONFIG[key]}`,
      );
      continue;
    }

    const { min, max } = LIMITS[key];
    const clamped = Math.min(Math.max(value, min), max);
    if (clamped !== value) {
      errors.push(`${SETTINGS_KEY}.${key} 超出 ${min}–${max}，已按 ${clamped} 处理`);
    }
    config[key] = clamped;
  }

  return { config, errors };
}

/**
 * 配置文件路径，规则与 pi 自己一致：PI_CODING_AGENT_DIR 优先，否则 ~/.pi/agent。
 * 这里自己拼路径而不从 pi 导入 getAgentDir，是为了让这个文件在普通 Node 下也能跑测试。
 */
function settingsPath(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir && envDir.length > 0) {
    const dir = envDir.startsWith("~/")
      ? join(homedir(), envDir.slice(2))
      : envDir;
    return join(dir, "settings.json");
  }
  return join(homedir(), ".pi", "agent", "settings.json");
}

/** 读取并校验配置；文件不存在或不是合法 JSON 时都静默用默认值。 */
export function readConfig(path: string): {
  config: TokenSpeedConfig;
  errors: string[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { config: { ...DEFAULT_CONFIG }, errors: [] };
  }

  const section =
    parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)[SETTINGS_KEY]
      : undefined;

  return resolveConfig(section);
}

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
  constructor(windowMs: number = DEFAULT_CONFIG.windowMs) {
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
  let config: TokenSpeedConfig = { ...DEFAULT_CONFIG };
  let notifiedConfigErrors = false;
  let run: Run | undefined;

  /** 每次开始运行前重读一次配置，改完 settings.json 不用重启。 */
  function loadConfig(context: ExtensionContext) {
    const result = readConfig(settingsPath());
    config = result.config;

    if (result.errors.length > 0 && !notifiedConfigErrors) {
      notifiedConfigErrors = true;
      context.ui.notify(
        `[pi-token-speed] ${result.errors.join("; ")}`,
        "warning",
      );
    }
  }

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
      window: new TokenSpeedWindow(config.windowMs),
    };
    run.timer = setInterval(render, config.refreshIntervalMs);
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

  pi.on("session_start", async (_event, ctx) => {
    loadConfig(ctx);
  });

  pi.on("message_start", async (event, ctx) => {
    if (event.message.role !== "assistant") return;

    // 一次 agent 运行可能有多条 assistant 消息（中间夹着工具调用），
    // 只有没有进行中的运行时才重新开始计时。
    if (run === undefined || !run.live) {
      loadConfig(ctx);
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
