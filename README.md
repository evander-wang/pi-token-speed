# pi-token-speed

A small [pi](https://github.com/badlogic/pi-mono) extension that shows the assistant output
token speed in pi's footer status bar, live while the model is streaming.

## Features

- **Sliding-window speed** — the live number is the rate over the last 3 s, not the average
  since the response started, so it reflects what the model is doing *now*.
- **Stall/burst correction** — when a provider buffers output and then flushes it in one
  batch, every sample shares a timestamp. The window detects that and divides by the span
  back to the previous batch instead of by a tiny clamp, so a 500-token flush after a 6 s
  stall reads ~83 tok/s instead of thousands.
- **Pauses while tools run** — time spent in `tool_execution_start` → `tool_execution_end`
  is excluded from the clock, and the window is restarted afterwards. A slow `bash` call no
  longer drags the number down.
- **Exact final number** — on `agent_end` the display switches to the sum of
  `usage.output` over all assistant **and** toolResult messages of the run, divided by actual
  generation time. No estimate involved.
- **Cheap local estimate while streaming** — CJK / kana / hangul count as roughly 1 token per
  character and everything else as roughly 4 characters per token, which matches
  mixed-language output better than a single divisor. Estimated values are prefixed with `~`.
- **Dependency-free and stateless** — nothing is persisted; the interval is cleared on
  `agent_end` and `session_shutdown`.

While streaming:

```text
⚡ ~42 tok/s
```

After the run finishes:

```text
⚡ 38 tok/s
```

## Install

Install directly from GitHub for all projects:

```bash
pi install git:github.com/evander-wang/pi-token-speed
```

Or try it for one run without adding it to your settings:

```bash
pi -e git:github.com/evander-wang/pi-token-speed
```

After installing, restart pi or run `/reload` in an existing session.

## Uninstall

```bash
pi remove git:github.com/evander-wang/pi-token-speed
```

## How it works

The extension uses pi's public Extension API:

- `message_start` (assistant) starts a run and a 500 ms refresh interval. A run is not
  restarted per message: one agent run can contain several assistant messages with tool calls
  in between.
- `message_update` feeds `text_delta` / `thinking_delta` / `toolcall_delta` into the window.
  It uses the provider's cumulative `usage.output` increment when it is available and falls
  back to the local character estimate otherwise.
- `tool_execution_start` / `tool_execution_end` pause the clock; parallel tool calls are
  tracked by id so the clock only resumes when the last one finishes.
- `agent_end` stops the run and renders the exact total from the run's messages.
- `ctx.ui.setStatus()` renders the footer; `session_shutdown` clears the interval.

The live number is an estimate of throughput, not a billing figure. Only the value after
`agent_end` comes from provider usage.

## Tunables

All of them are constants at the top of `extensions/token-speed.ts`:

| Constant | Default | Meaning |
| --- | --- | --- |
| `WINDOW_MS` | `3000` | Sliding window for the live rate. Longer = steadier, shorter = more reactive. |
| `MIN_SPAN_MS` | `250` | Floor for the window span, so a same-millisecond flush cannot divide by ~0. |
| `REFRESH_INTERVAL_MS` | `500` | Footer refresh cadence while streaming. |
| `MIN_ELAPSED_MS` | `400` | Below this, the rate is too noisy to show. |

## Development

Test the extension from a checkout:

```bash
pi -e ./extensions/token-speed.ts
npm test
```

The tests run on Node's built-in test runner with mocked timers (Node 22.18+ strips
TypeScript types natively, so there is no build step). `TokenSpeedWindow` is exported so the
rate math can be tested without a pi session.

## Notes

This package is unrelated to the npm package `pi-token-speed` by
[gsanhueza](https://github.com/gsanhueza/pi-token-speed); it is an independent implementation
with a different counting model.

The package follows pi's package convention with a `pi` manifest in `package.json`. The pi
core package is declared as an **optional** peer dependency: the extension only imports types
from it (pi injects the runtime API object when loading the extension), so declaring it as a
required peer would make npm pull a copy of pi core into the package directory on install.

## License

MIT
