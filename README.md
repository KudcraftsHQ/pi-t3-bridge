# pi-t3-bridge

Run the [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
as a native provider inside [T3 Code](https://github.com/pingdotgg/t3code) — threads,
streaming, tool cards and approval prompts, on desktop and in the Android app.

T3 has no pi driver. `piAgent` is still a "coming soon" chip in its Add Provider
dialog with no server-side implementation. But T3's **Cursor** driver spawns an
arbitrary binary and talks standard ACP to it, and it is the only driver that ships
no built-in model list — it reads every model from your settings. That makes it a
usable host. This bridge impersonates the Cursor Agent CLI closely enough to pass
T3's health probe, then serves pi over ACP.

**No fork of t3code is required.**

## Install

```bash
git clone https://github.com/KudcraftsHQ/pi-t3-bridge
cd pi-t3-bridge
bun install
ln -sf "$PWD/bin/pi-t3-bridge" ~/.local/bin/pi-t3-bridge
pi-t3-bridge about --format json   # sanity check
```

Then add a provider instance to `~/.t3/userdata/settings.json`:

```json
"providerInstances": {
  "cursor_pi": {
    "driver": "cursor",
    "enabled": true,
    "displayName": "pi (bridge)",
    "config": {
      "binaryPath": "/home/you/.local/bin/pi-t3-bridge",
      "apiEndpoint": "",
      "customModels": ["deepseek/deepseek-v4-flash"]
    }
  }
}
```

T3 hot-reloads settings; no restart needed. `customModels` is only a fallback —
once the bridge answers `cursor/list_available_models`, the picker lists pi's real
catalog.

If you do not otherwise use Cursor, set `providers.cursor.enabled` to `false` so
T3 stops probing a `cursor-agent` binary you never installed.

## How it works

```
T3 server ──spawn──> pi-t3-bridge acp ──ACP/JSON-RPC v1──> pi AgentSession
          <─about──
```

One binary, two argv modes:

| Mode | Purpose |
|---|---|
| `about [--format json]` | Health probe. T3 runs this to decide whether the provider is ready |
| `acp` | ACP agent over stdio |

T3 may prepend flags before `acp` (`-e <endpoint>`, and `--auto-review` / `--force`
depending on the thread's runtime mode), so argv is scanned rather than matched
positionally. `--force` and `--auto-review` are taken as "stop asking about every
tool call" and switch approvals off.

## The gates

T3's Cursor probe is strict. These are the requirements the bridge satisfies, each
read out of `apps/server/src/provider/Layers/CursorProvider.ts`:

| Gate | Requirement |
|---|---|
| Probe | Answer `about --format json` within 8s (`ABOUT_TIMEOUT_MS`) |
| Version | `cliVersion` must match `^\d{4}\.\d{2}\.\d{2}` and be ≥ **2026.04.08** |
| Channel | `~/.cursor/cli-config.json` must be absent or set `"channel": "lab"` |
| Auth | `userEmail` must be a non-empty string that doesn't read as logged out |
| Auth method | ACP `initialize` must advertise `cursor_login` |
| Models | `cursor/list_available_models` — optional; failure degrades to a warning |

`test/compat.test.ts` encodes these. If T3 tightens a gate, that file is what to
update first.

> **The channel gate reads a global file.** If a real Cursor CLI is ever installed
> and writes a non-`lab` channel to `~/.cursor/cli-config.json`, both the real
> Cursor instance and this bridge stop working at once.

## Reasoning effort

T3's effort dropdown is not something T3 invents — it builds the control from the
`configOptions` an agent reports, and drives selections back through
`session/set_config_option`. The bridge reports an `effort` option, so the dropdown
appears and maps onto pi's thinking level.

Two things are worth knowing:

- **Only five levels are offered.** pi has `off` and `minimal` as well, but T3's
  value normalizer discards anything outside low / medium / high / xhigh / max, so
  offering them would produce dropdown entries that silently do nothing.
- **pi clamps to the model.** `deepseek-v4-flash` supports only low / high / max, so
  asking for `xhigh` lands on `max` and `medium` lands on `high`. The bridge reports
  the *clamped* value back, so the dropdown shows what is actually running rather
  than what was requested.

Models that do not reason get no dropdown at all.

## Images and files

Both work, and they arrive by different routes.

**Images** come through as ACP `image` blocks — T3 base64-encodes the attachment
and the bridge hands it to pi as `ImageContent`. Verified against
`deepseek-v4-flash-vision-exp`: a solid purple PNG reads back "Purple", an orange
one "Orange".

**Generic files never become blocks at all.** T3's Cursor adapter skips non-image
attachments outright — *"Cursor ingests images only. Generic files reach the agent
through the path line ProviderService puts in the prompt"* — so the agent receives
a path and opens it with pi's own `read` tool. That means `@`-mentioned files and
dropped files work without the bridge doing anything, and they are not limited by
what ACP can carry.

One consequence worth knowing: because the file is read by a tool rather than
embedded, a file attachment costs a tool round-trip and is subject to approval in
modes where tools require it.

## Extensions

**Discovery is off by default.** pi's extension ecosystem is written for its
interactive TUI, and an extension that reaches for the theme singleton mid-turn (the
tps-meter does) throws outside it and takes the bridge process down. Skills, prompt
templates and context files are unaffected.

Some extensions are load-bearing for *correctness*, not display, and those can be
allowlisted by name:

```json
"environment": [{ "name": "PI_T3_BRIDGE_EXTENSIONS", "value": "deepseek-peak" }]
```

A bare name resolves against `~/.pi/agent/extensions/`. Anything with a separator is
treated as a path.

**`deepseek-peak` is the case that motivated this.** DeepSeek bills at half rate
outside its peak windows, and pi's `models.json` cost model has no time dimension —
so without the extension every cost pi records is priced at peak. Measured on the
same 134-token request:

| | effective input rate |
|---|---|
| without the extension | $0.300 / Mtok |
| with it allowlisted | $0.150 / Mtok |

Only allowlist extensions that guard their UI calls behind `ctx.hasUI`. One that
does not will crash the bridge mid-turn.

The UI will also say "Cursor", with a Cursor icon and an "Early Access" badge. That
is cosmetic and unavoidable without a fork.

## Development

```bash
bun test                                                   # gate + mapping tests
bun scripts/smoke.ts <cwd> <model-slug> "<prompt>"         # drive it like T3 does
SMOKE_DENY=1 bun scripts/smoke.ts <cwd> <model> "<prompt>" # exercise the deny path
```

`scripts/smoke.ts` is a miniature ACP client: it does the handshake, creates a
session, streams updates, and answers permission requests.

## Status

Working: handshake, model discovery and selection, prompt streaming, thinking
chunks, tool calls with kinds and locations, and approvals in both directions.

Session resumption works: T3 calls `session/load` whenever a thread reopens, and
the bridge maps the ACP session id back onto its pi session file via a small store
at `~/.pi/t3-bridge-sessions.json` (override with `PI_T3_BRIDGE_STATE`). T3 spawns a
fresh provider process per session runtime, so that mapping has to survive on disk.
If the lookup misses, it falls back to the most recent pi session in the same
directory.

Not implemented: ACP terminal methods, `fs/*` client delegation (pi uses its own
file tools), and MCP server pass-through.

## Steering

Sending a message while a turn is still running is steering, and it needs two
things that are easy to get wrong:

- pi refuses a prompt during a turn unless told how to queue it
  (`streamingBehavior: "steer" | "followUp"`). The bridge passes `"steer"` by
  default, matching what T3 means by a mid-turn message.
- **Never subscribe per prompt.** pi dispatches events with
  `for (const l of this._eventListeners)` over the live array, so a listener that
  unsubscribes itself mid-dispatch shifts the array and the iterator skips the next
  listener. One subscription is held per session and prompts wait on a resolver
  list instead.

### steer vs followUp

pi supports both. **T3 can only ask for one of them**, so the choice is per
instance rather than per message:

```json
"environment": [{ "name": "PI_T3_BRIDGE_STEERING", "value": "followUp" }]
```

| | behaviour |
|---|---|
| `steer` (default) | Delivered after the current tool batch, before the next LLM call — redirects the turn |
| `followUp` | Waits for the turn to finish, then runs |

The limitation is not the bridge's. ACP's `PromptRequest` is
`{sessionId, prompt, messageId?, _meta?}` — it has no queueing field — and T3
treats every mid-turn prompt as a steer: *"A sendTurn while a prompt is in flight
is a steer: the agent folds the new prompt into the ongoing work"*
(`CursorAdapter.ts`), reusing the active turn id. The ACP runtime's internal
`promptOptions` carries only a `dispatched` deferred, nothing about queueing.

So `steer` is the honest default — it is what T3's UI is describing when you type
mid-turn. `followUp` is there for anyone who prefers their interruptions to be
polite.

## Debugging

Set `PI_T3_BRIDGE_DEBUG=1` for stderr tracing of prompt lifecycle (stdout is the
protocol channel and is never touched).

Set `PI_T3_BRIDGE_LOG` to a path and every invocation records its argv, cwd and
parent pid. T3 spawns the binary itself, so this is the only way to see what it
was actually asked to do:

```json
"environment": [{ "name": "PI_T3_BRIDGE_LOG", "value": "/tmp/pi-t3-bridge.log" }]
```

## Licence

MIT
