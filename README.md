# pi-token-speed

A small [pi](https://github.com/badlogic/pi-mono) extension that shows the assistant output
token speed in pi's footer status bar, live while the model is streaming.

## Features

- Recomputes the rate every 500 ms while a response is streaming, instead of redrawing on
  every delta.
- Skips the first 400 ms: on very short responses the rate swings wildly and is misleading.
- Prefers the provider's reported `usage.output` when it is available, and falls back to a
  local character-based estimate while streaming.
- Estimates CJK / kana / hangul as roughly 1 token per character and everything else as
  roughly 4 characters per token, which is closer to reality for mixed-language output than
  a single divisor.
- Distinguishes exact from estimated values by color and a `~` prefix, so you can tell which
  one you are looking at.
- Clears the interval on `session_shutdown`; stores no session or task data.

While streaming (estimated):

```text
⚡ ~42 tok/s
```

After completion (exact):

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

- `message_start` starts a 500 ms interval for assistant messages.
- `message_update` accumulates `text_delta` / `thinking_delta` / `toolcall_delta` into a
  local estimate and picks up `usage.output` once the provider reports it.
- `message_end` renders the final value and prefers the exact usage number.
- `ctx.ui.setStatus()` renders the status in the footer; `session_shutdown` clears the timer.

The token counts shown while streaming are estimates, not provider billing numbers. Only the
value after completion comes from `usage.output`.

## Notes

This package is unrelated to the npm package `pi-token-speed` by
[gsanhueza](https://github.com/gsanhueza/pi-token-speed); it is an independent implementation.

## Development

Test the extension from a checkout:

```bash
pi -e ./extensions/token-speed.ts
```

The package follows pi's package convention with a `pi` manifest in `package.json`. The pi
core package is declared as a peer dependency and is not bundled.

## License

MIT
