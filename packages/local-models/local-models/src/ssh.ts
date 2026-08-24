/**
 * SSH transport and endpoint probe for the local-model seam. The harness runs
 * on a workstation; the model servers run on a remote host reached over
 * passwordless SSH. Discovery, launch, and stop are one `ssh <target> '<remote
 * shell command>'` each, driven through a {@link RemoteRunner} so the seam's
 * orchestration is unit-testable without a real `ctx.subprocess` or network;
 * run-state comes from a plain `fetch` probe of the model endpoint.
 *
 * @module @deepseek-ai/dsh-local-models/ssh
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import type { LocalModelStatus } from './types.ts'

/** Bounded capture for one remote command's streams (discovery output is small). */
const CAPTURE_MAX_BYTES = 256 * 1024

/** SSH's own exit code for a connection/authentication failure (distinct from any remote exit). */
const SSH_CONNECT_EXIT = 255

/** Remote `exit` used by the discovery snippet when the scripts directory is absent. */
const NO_SCRIPTS_DIR_EXIT = 3

/** Remote `exit` used by the start snippet when the resolved run script is missing. */
const NO_SCRIPT_EXIT = 4

/** Exit code `pkill` returns when no process matched — an already-stopped endpoint, not a failure. */
const PKILL_NO_MATCH_EXIT = 1

/** One remote-shell script parsed out of discovery, before run-state is folded in. */
export interface DiscoveredScript {
  /** Script slug (`run-*.sh` minus `run-`/`.sh`). */
  id: string
  /** Absolute path of the run script on the remote host. */
  scriptPath: string
  /** Statically parsed `--alias`; absent when the script computes it. */
  alias?: string
  /** Header-comment description, when the script's second line is a comment. */
  description?: string
  /** Value of a `# drafter:` header tag (e.g. `DFlash 2`), when present. */
  drafter?: string
  /** Whether a `# nudge:` header tag reads on/off; absent when the tag is missing. */
  nudge?: boolean
}

/** Outcome of one remote command: the remote exit code (null on signal death) and captured streams. */
export interface RemoteRunResult {
  /** Remote command exit code; SSH failures surface as {@link SSH_CONNECT_EXIT}. */
  exitCode: number | null
  /** Captured stdout text. */
  stdout: string
  /** Captured stderr text. */
  stderr: string
}

/** Runs one `argv` to completion and returns its exit code and captured output. */
export interface RemoteRunner {
  /**
   * Execute `argv` (never shell-interpreted locally) and resolve with its exit
   * code and captured streams.
   * @param argv - executable and arguments; `argv[0]` is the program.
   * @param signal - aborts the run.
   * @returns the settled exit code and captured stdout/stderr.
   */
  run(argv: readonly string[], signal?: AbortSignal): Promise<RemoteRunResult>
}

/**
 * Adapt `ctx.subprocess` into a {@link RemoteRunner}: one collected-output
 * managed child per command, read after settlement. The subprocess service
 * owns the credential scrub, so `ssh` inherits `HOME`/`PATH` (its key and
 * config) but not the harness's secrets.
 * @param ctx - context providing the subprocess service.
 * @param graceMs - kill-escalation grace to apply per spawn.
 * @returns a runner backed by the subprocess seam.
 */
export function createSubprocessRunner(ctx: Context, graceMs: () => number): RemoteRunner {
  return {
    async run(argv, signal) {
      const handle = ctx.subprocess.spawn({
        argv,
        cwd: process.cwd(),
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: CAPTURE_MAX_BYTES },
          stderr: { maxBytes: CAPTURE_MAX_BYTES },
        },
        graceMs: graceMs(),
        ...signal ? { signal } : {},
      })
      const outcome = await handle.done
      return {
        exitCode: outcome.exitCode,
        stdout: handle.collected.stdout?.readFrom(0).text ?? '',
        stderr: handle.collected.stderr?.readFrom(0).text ?? '',
      }
    },
  }
}

/**
 * Whether a slug is safe to interpolate unquoted into a remote shell command.
 * @param id - the candidate model slug.
 * @returns true when the slug is only safe characters.
 */
export function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9._+-]+$/.test(id)
}

/**
 * Whether a directory path is safe to interpolate unquoted (so a leading `~` still expands remotely).
 * @param dir - the candidate scripts directory.
 * @returns true when the path is non-empty and only safe characters.
 */
export function isSafeDir(dir: string): boolean {
  return dir.length > 0 && /^[A-Za-z0-9._~/-]+$/.test(dir)
}

/**
 * The run-script filename for a slug.
 * @param id - the model slug.
 * @returns the `run-<id>.sh` filename.
 */
export function scriptFilename(id: string): string {
  return `run-${id}.sh`
}

/**
 * Derive a slug from a `run-*.sh` filename.
 * @param filename - the run-script filename.
 * @returns the slug with `run-` and `.sh` stripped.
 */
export function deriveId(filename: string): string {
  return filename.replace(/^run-/, '').replace(/\.sh$/, '')
}

/**
 * Parse the `--alias` / `ALIAS=` line discovery captured. Handles `--alias x`,
 * `--alias 'x'`, `ALIAS=x`, and `ALIAS="${ALIAS:-x}"`; a value that is (or
 * contains) a shell variable is computed at launch and returns undefined.
 * @param aliasLine - the captured line, or undefined when none was found.
 * @returns the static alias, or undefined.
 */
export function parseAlias(aliasLine: string | undefined): string | undefined {
  if (aliasLine === undefined) return undefined
  const dfault = /ALIAS=["']?\$\{ALIAS:-([A-Za-z0-9._:+-]+)\}/.exec(aliasLine)?.[1]
  if (dfault !== undefined) return dfault
  const flag = /--alias[=\s]+["']?([A-Za-z0-9._:+-]+)/.exec(aliasLine)?.[1]
  if (flag !== undefined && !flag.includes('$')) return flag
  const assign = /(?:^|\s)ALIAS=["']?([A-Za-z0-9._:+-]+)/.exec(aliasLine)?.[1]
  if (assign !== undefined && !assign.includes('$')) return assign
  return undefined
}

/**
 * Parse a `# drafter:` header tag value (e.g. `DFlash 2`, `DSpark`, `none`).
 * @param drafterLine - the captured `# drafter:` line, or undefined.
 * @returns the trimmed drafter label, or undefined when absent or empty.
 */
export function parseDrafter(drafterLine: string | undefined): string | undefined {
  if (drafterLine === undefined) return undefined
  const value = /#+\s*drafter:\s*(.+)/i.exec(drafterLine)?.[1]?.trim()
  return value !== undefined && value.length > 0 ? value : undefined
}

/**
 * Parse a `# nudge:` header tag as an on/off flag.
 * @param nudgeLine - the captured `# nudge:` line, or undefined.
 * @returns true/false for a recognized on/off value, else undefined.
 */
export function parseNudge(nudgeLine: string | undefined): boolean | undefined {
  if (nudgeLine === undefined) return undefined
  const value = /#+\s*nudge:\s*(\S+)/i.exec(nudgeLine)?.[1]?.toLowerCase()
  if (value === undefined) return undefined
  if (['on', 'yes', 'true', '1', 'active', 'enabled'].includes(value)) return true
  if (['off', 'no', 'false', '0', 'inactive', 'stock', 'disabled'].includes(value)) return false
  return undefined
}

/**
 * Parse the tab-separated discovery output (one record per script:
 * `filename\taliasLine\tdescLine\tabsPath\tdrafterLine\tnudgeLine`) into
 * structured scripts. Lines without the field separator are skipped, so any
 * shell noise is inert.
 * @param stdout - the discovery command's stdout.
 * @returns the discovered scripts in listing order.
 */
export function parseDiscoverOutput(stdout: string): DiscoveredScript[] {
  const scripts: DiscoveredScript[] = []
  for (const line of stdout.split('\n')) {
    if (!line.includes('\t')) continue
    const [filename, aliasLine, descLine, scriptPath, drafterLine, nudgeLine] = line.split('\t')
    if (filename === undefined || filename === '') continue
    const alias = parseAlias(aliasLine === undefined || aliasLine === '' ? undefined : aliasLine)
    const description = descLine !== undefined && descLine.startsWith('#')
      ? descLine.replace(/^#+\s?/, '').trim()
      : undefined
    const drafter = parseDrafter(drafterLine === undefined || drafterLine === '' ? undefined : drafterLine)
    const nudge = parseNudge(nudgeLine === undefined || nudgeLine === '' ? undefined : nudgeLine)
    scripts.push({
      id: deriveId(filename),
      scriptPath: scriptPath ?? '',
      ...alias !== undefined ? { alias } : {},
      ...description !== undefined && description.length > 0 ? { description } : {},
      ...drafter !== undefined ? { drafter } : {},
      ...nudge !== undefined ? { nudge } : {},
    })
  }
  return scripts
}

/**
 * A compact display name for a discovered script: the leading segment of its
 * header comment before the first spaced dash or sentence break, so a verbose
 * comment renders as a short model name; falls back to the alias, then the id.
 * @param script - the discovered script's descriptive fields.
 * @returns a short human-readable model name.
 */
export function conciseLocalModelName(
  script: Pick<DiscoveredScript, 'description' | 'alias' | 'id'>,
): string {
  if (script.description !== undefined) {
    const head = script.description.split(/\s+[—–-]\s+|\.\s+/u)[0]?.trim()
    if (head !== undefined && head.length > 0) return head
  }
  return script.alias ?? script.id
}

/**
 * The dropdown display name: the {@link conciseLocalModelName} base, then the
 * `# drafter:` tag and the `# nudge:` state when the script tags them, joined
 * with ` · ` (e.g. `Qwen3.8-27B (unsloth Q8_0) · DFlash 2 · nudge`).
 * @param script - the discovered script's descriptive and tag fields.
 * @returns the composed display name.
 */
export function localModelDisplayName(
  script: Pick<DiscoveredScript, 'description' | 'alias' | 'id' | 'drafter' | 'nudge'>,
): string {
  const parts = [conciseLocalModelName(script)]
  if (script.drafter !== undefined) parts.push(script.drafter)
  if (script.nudge !== undefined) parts.push(script.nudge ? 'nudge' : 'no nudge')
  return parts.join(' · ')
}

/** Remote shell command listing `run-*.sh` (excluding `.bak`) with the fields discovery parses. */
function discoverSnippet(scriptsDir: string): string {
  // scriptsDir is interpolated unquoted (validated by isSafeDir) so a leading
  // `~` expands in the remote login shell; every emitted field is tab-joined
  // and any embedded tabs are squeezed out so parsing stays line-oriented.
  return `cd ${scriptsDir} 2>/dev/null || exit ${NO_SCRIPTS_DIR_EXIT}
for f in run-*.sh; do
  case "$f" in *.bak*) continue ;; esac
  [ -f "$f" ] || continue
  a=$(grep -m1 -E -- '--alias|^[[:space:]]*ALIAS=' "$f" 2>/dev/null | tr '\\t' ' ')
  d=$(sed -n '2p' "$f" 2>/dev/null | tr '\\t' ' ')
  dr=$(grep -m1 -iE '^#+[[:space:]]*drafter:' "$f" 2>/dev/null | tr '\\t' ' ')
  nu=$(grep -m1 -iE '^#+[[:space:]]*nudge:' "$f" 2>/dev/null | tr '\\t' ' ')
  printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$f" "$a" "$d" "$(pwd)/$f" "$dr" "$nu"
done`
}

/** Remote shell command launching one run script detached, surviving the SSH session close. */
function startSnippet(scriptsDir: string, id: string): string {
  const script = scriptFilename(id)
  return `cd ${scriptsDir} 2>/dev/null || exit ${NO_SCRIPTS_DIR_EXIT}
[ -f ./${script} ] || exit ${NO_SCRIPT_EXIT}
setsid nohup ./${script} > ./${id}.serverlog 2>&1 < /dev/null &
echo started`
}

/** Raise the exit-code failures shared by every remote command; returns on success. */
function assertRemoteOk(result: RemoteRunResult, cfg: TransportConfig, action: string): void {
  if (result.exitCode === SSH_CONNECT_EXIT) {
    throw new Error(`local-models: ssh to ${cfg.sshTarget} failed: ${result.stderr.trim() || 'connection error'}`)
  }
  if (result.exitCode === NO_SCRIPTS_DIR_EXIT) {
    throw new Error(`local-models: scripts directory not found on ${cfg.sshTarget}: ${cfg.scriptsDir}`)
  }
  if (result.exitCode !== 0) {
    throw new Error(`local-models: ${action} failed (exit ${String(result.exitCode)}): ${result.stderr.trim()}`)
  }
}

/** The transport-relevant slice of the seam config. */
export interface TransportConfig {
  sshTarget: string
  scriptsDir: string
  probeBaseURL: string
  execCommand: string
  stopCommand: string
  probeTimeoutMs: number
}

/**
 * Enumerate the remote run scripts.
 * @param runner - remote command runner.
 * @param cfg - transport config (ssh target, scripts dir, exec command).
 * @param signal - aborts discovery.
 * @returns the discovered scripts, `.bak` excluded.
 * @throws Error naming an unsafe scripts directory, an SSH failure, or a non-zero remote exit.
 */
export async function discover(
  runner: RemoteRunner,
  cfg: TransportConfig,
  signal?: AbortSignal,
): Promise<DiscoveredScript[]> {
  if (!isSafeDir(cfg.scriptsDir)) throw new Error(`local-models: unsafe scripts directory: ${cfg.scriptsDir}`)
  const result = await runner.run([cfg.execCommand, cfg.sshTarget, discoverSnippet(cfg.scriptsDir)], signal)
  assertRemoteOk(result, cfg, 'discovery')
  return parseDiscoverOutput(result.stdout)
}

/**
 * Launch one run script detached on the remote host.
 * @param runner - remote command runner.
 * @param cfg - transport config.
 * @param id - script slug to launch.
 * @param signal - aborts the launch command (not the launched server).
 * @throws Error naming an unsafe id/dir, a missing script, an SSH failure, or a non-zero remote exit.
 */
export async function startScript(
  runner: RemoteRunner,
  cfg: TransportConfig,
  id: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!isSafeId(id)) throw new Error(`local-models: unsafe model id: ${id}`)
  if (!isSafeDir(cfg.scriptsDir)) throw new Error(`local-models: unsafe scripts directory: ${cfg.scriptsDir}`)
  const result = await runner.run([cfg.execCommand, cfg.sshTarget, startSnippet(cfg.scriptsDir, id)], signal)
  if (result.exitCode === NO_SCRIPT_EXIT) {
    throw new Error(`local-models: no run script for "${id}" in ${cfg.scriptsDir}`)
  }
  assertRemoteOk(result, cfg, `start of "${id}"`)
}

/**
 * Stop the running model server via the configured stop command. `pkill`
 * reporting no match is an already-stopped endpoint, not a failure.
 * @param runner - remote command runner.
 * @param cfg - transport config (carries the stop command).
 * @param signal - aborts the stop command.
 * @throws Error on an SSH failure or a stop-command exit other than success/no-match.
 */
export async function stopServer(
  runner: RemoteRunner,
  cfg: TransportConfig,
  signal?: AbortSignal,
): Promise<void> {
  const result = await runner.run([cfg.execCommand, cfg.sshTarget, cfg.stopCommand], signal)
  if (result.exitCode === SSH_CONNECT_EXIT) {
    throw new Error(`local-models: ssh to ${cfg.sshTarget} failed: ${result.stderr.trim() || 'connection error'}`)
  }
  if (result.exitCode !== 0 && result.exitCode !== PKILL_NO_MATCH_EXIT) {
    throw new Error(`local-models: stop failed (exit ${String(result.exitCode)}): ${result.stderr.trim()}`)
  }
}

/** Compose the caller's signal (if any) with a per-probe timeout. */
function probeSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

/** Read the running model id from a `/v1/models` body across llama.cpp response shapes. */
function extractRunningAlias(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const record = body as { data?: unknown; models?: unknown }
  const fromData: unknown = Array.isArray(record.data) ? record.data[0] : undefined
  if (typeof fromData === 'object' && fromData !== null && 'id' in fromData && typeof fromData.id === 'string') {
    return fromData.id
  }
  const fromModels: unknown = Array.isArray(record.models) ? record.models[0] : undefined
  if (typeof fromModels === 'object' && fromModels !== null && 'name' in fromModels && typeof fromModels.name === 'string') {
    return fromModels.name
  }
  return null
}

/**
 * Probe the model endpoint for liveness and the served model id. A down or
 * unreachable endpoint is the ordinary "no model running" signal, not an error,
 * so transport failures resolve to `{ runningAlias: null, healthy: false }`.
 * @param cfg - transport config (probe base URL and timeout).
 * @param signal - aborts the probe.
 * @returns the endpoint's health and served model id.
 */
export async function probeStatus(cfg: TransportConfig, signal?: AbortSignal): Promise<LocalModelStatus> {
  const base = cfg.probeBaseURL.replace(/\/+$/, '')
  const healthy = await fetch(`${base}/health`, { signal: probeSignal(signal, cfg.probeTimeoutMs), redirect: 'error' })
    .then(response => response.ok)
    // A refused, timed-out, or redirecting endpoint means no model is up.
    .catch(() => false)
  if (!healthy) return { runningAlias: null, healthy: false }
  const runningAlias = await fetch(`${base}/v1/models`, { signal: probeSignal(signal, cfg.probeTimeoutMs), redirect: 'error' })
    .then(response => response.ok ? response.json() : null)
    .then(extractRunningAlias)
    // Health is up but the model list was unreadable — report healthy, id unknown.
    .catch(() => null)
  return { runningAlias, healthy: true }
}
