# @deepseek-ai/dsh-local-models

English | [中文](README.zh.md)

The `ctx.localModels` capability seam and its single SSH implementation: lifecycle control for local model servers running on a remote host. It lets the model dropdown list every local model, show which one is running, and start/stop them.

This is a **service** package: it default-exports the `LocalModelManager` service class, which registers as `ctx.localModels`. It is **opt-in** — mount it only in a deployment where a workstation drives model servers on a reachable host; it is not part of the shipped `dsh-base` bundle. The `localModels.*` Host RPC domain no-ops (a null catalog) when the seam is absent, and the web app's **Local models** dropdown section renders only when the seam returns entries.

## How it works

The harness runs on a workstation; the model servers run on a remote host reached over **passwordless SSH**. The seam models the reality that a `llama-server`-style endpoint serves **one model at a time** on a single port and ignores the requested model id — so a model's identity is a *lifecycle handle* (which run script to launch), not an llm-routing distinction. Every local model routes to one configured llm selection (`route`).

- **Discover** — one `ssh <sshTarget> '…'` lists `run-*.sh` in `scriptsDir` (`.bak` excluded) and parses each script's `--alias`, its second-line header comment, and two optional header tags (`# drafter:` and `# nudge:`).
- **Start** — stops the current server (only one fits the port), then launches the chosen script detached (`setsid nohup ./run-<id>.sh > ./<id>.serverlog 2>&1 </dev/null &`) so it survives the SSH session close. The model reads as `starting` until a probe sees it up, bounded by `startTimeoutMs` (computed from a timestamp, not a background timer).
- **Stop** — runs `stopCommand` (default `pkill -f llama-server`) on the host.
- **Run-state** — a plain `fetch` of `${probeBaseURL}/health` (up when 200) and `/v1/models` (the served alias). The served alias is matched back to a script; a start this seam issued is attributed to the model it launched.

A start or stop emits `localModels/state-changed`, a payload-free nudge (like `llm/adapters-updated`) that makes every client refetch the catalog.

### Naming a model from its script

Each dropdown row is named from the run script itself, so the list stays short and carries the details that distinguish otherwise-similar builds:

- **Base name** — the leading segment of the script's **second line** header comment, taken before the first spaced dash (`—`/`–`/`-`) or sentence break; a script with no header comment falls back to its `--alias`, then its slug.
- **`# drafter:` tag** — the speculative drafter label (any text, e.g. `DFlash`, `DFlash 2`, `DSpark`, `none`), appended after the base name. It may appear on **any** header line.
- **`# nudge:` tag** — whether the nudge patch is active. `on`/`yes`/`true`/`1`/`active`/`enabled` render `· nudge`; `off`/`no`/`false`/`0`/`inactive`/`stock`/`disabled` render `· no nudge`; any other value (or an absent tag) adds nothing.

Segments join with ` · `. A script tagged this way:

```sh
#!/usr/bin/env bash
# Qwen3.8-27B (unsloth Q8_0) — MTP self-speculation, 128k context
# drafter: DFlash 2
# nudge: on
exec llama-server --alias qwen3.8 --port 8080 ...
```

lists as **`Qwen3.8-27B (unsloth Q8_0) · DFlash 2 · nudge`**. Drafter and nudge cannot be inferred reliably from build paths or `--spec-type` flags, so they are read only from these explicit tags; untagged scripts simply show their base name.

## Config

All fields are validated settings; deployment-varying knobs carry defaults.

| Key | Default | Meaning |
|---|---|---|
| `sshTarget` | (required) | SSH destination of the model host (e.g. an `ssh_config` host alias). |
| `scriptsDir` | (required) | Directory of the `run-*.sh` launch scripts on the host; a leading `~` expands there. |
| `probeBaseURL` | (required) | Base URL of the model endpoint, probed for `/health` and `/v1/models`. |
| `providerId` | (required) | The llm provider id whose dropdown group this section supersedes. |
| `route` | (required) | `{ provider, model }` — the llm selection to activate once a local server is up. |
| `execCommand` | `ssh` | Local executable that reaches the host. |
| `stopCommand` | `pkill -f llama-server` | Remote command that stops the running server. |
| `startTimeoutMs` | `180000` | How long a launched-but-unready model reads as `starting`. |
| `probeTimeoutMs` | `5000` | Per-request timeout for each endpoint probe. |
| `graceMs` | `5000` | SIGTERM→SIGKILL grace for the local `ssh` child. |

```yaml
- name: '@deepseek-ai/dsh-local-models'
  config:
    sshTarget: dashi
    scriptsDir: ~/scripts/run
    probeBaseURL: http://192.168.0.131:8080
    providerId: local
    route: { provider: local, model: qwen3.8 }
```

## Model Experience

None, as this operator-facing lifecycle seam registers no model-facing tool and enters no model request.

#### KV Cache effect

None directly. Switching the running model changes what the shared local endpoint serves; the request prefix is owned by the llm route, not this seam. Starting, stopping, and run-state are not model-visible inputs, so they carry no session-log events — they ride the forwarded `localModels/state-changed` host event instead.

## Known Limitations and Deferred Work

- **Single transport (SSH).** Only an `ssh`-reachable host is supported. A supervised (systemd) transport or a remote HTTP model-manager would be separate providers of this seam; the Service Definition and its single implementation live in one package until a second transport exists.
- **Passwordless SSH required.** The seam shells out through `ctx.subprocess`; interactive auth is unsupported.
- **One model per endpoint.** `start` always stops the current server first; concurrent models on distinct ports are not modeled.
- **Computed aliases are opaque.** A script whose `--alias` is a shell variable (`$MODEL_ALIAS`) has no statically-parsed alias; its run-state is then attributed only to a start this seam issued, not to an externally-launched server.
- **`stopCommand` is host-shaped.** The default `pkill -f llama-server` is a configurable remote command; a deployment whose server process is named differently (or runs under a supervisor) must set its own.
