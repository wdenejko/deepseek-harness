/** SSH transport, discovery parsing, and endpoint probe for the local-model seam. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessOutputReader, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import {
  conciseLocalModelName, createSubprocessRunner, deriveId, discover, isSafeDir, isSafeId,
  localModelDisplayName, parseAlias, parseDiscoverOutput, parseDrafter, parseNudge,
  probeStatus, scriptFilename, startScript, stopServer,
} from '../src/ssh.ts'
import type { RemoteRunResult, RemoteRunner, TransportConfig } from '../src/ssh.ts'

const CFG: TransportConfig = {
  sshTarget: 'dashi',
  scriptsDir: '~/scripts/run',
  probeBaseURL: 'http://host.test:8080',
  execCommand: 'ssh',
  stopCommand: 'pkill -f llama-server',
  probeTimeoutMs: 1_000,
}

/** A runner returning one canned result and recording the argv it was handed. */
function runnerOf(result: RemoteRunResult, calls: string[][] = []): RemoteRunner {
  return {
    run(argv) {
      calls.push([...argv])
      return Promise.resolve(result)
    },
  }
}

/** A collect-mode reader that always returns the whole canned text. */
function reader(text: string): SubprocessOutputReader {
  return { readFrom: () => ({ text, nextOffset: text.length, lossy: false }) }
}

/** A settled subprocess handle with canned collected streams. */
function fakeHandle(stdout: string | undefined, stderr: string | undefined, exitCode: number | null): SubprocessHandle {
  return {
    pid: 1,
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    collected: {
      ...stdout !== undefined ? { stdout: reader(stdout) } : {},
      ...stderr !== undefined ? { stderr: reader(stderr) } : {},
    },
    done: Promise.resolve({ exitCode, signal: null }),
    terminate() {},
    waitForExit: () => Promise.resolve(true),
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('safe-interpolation guards', () => {
  it('accepts run-script slugs and rejects shell metacharacters', () => {
    expect(isSafeId('qwen3.8-unsloth-q8-dflash2')).toBe(true)
    expect(isSafeId('a b')).toBe(false)
    expect(isSafeId('a;rm -rf /')).toBe(false)
    expect(isSafeId('a/b')).toBe(false)
    expect(isSafeId('')).toBe(false)
  })

  it('accepts tilde/paths and rejects unsafe directories', () => {
    expect(isSafeDir('~/scripts/run')).toBe(true)
    expect(isSafeDir('/home/u/scripts')).toBe(true)
    expect(isSafeDir('')).toBe(false)
    expect(isSafeDir('a b')).toBe(false)
    expect(isSafeDir('$(x)')).toBe(false)
  })
})

describe('slug/filename helpers', () => {
  it('derives ids and filenames symmetrically', () => {
    expect(deriveId('run-qwen3.8-unsloth-q8.sh')).toBe('qwen3.8-unsloth-q8')
    expect(deriveId('run-ornith-1.5-q8.sh')).toBe('ornith-1.5-q8')
    expect(scriptFilename('ornith-1.5-q8')).toBe('run-ornith-1.5-q8.sh')
  })
})

describe('parseAlias', () => {
  it('reads the default of an ALIAS="${ALIAS:-x}" assignment', () => {
    expect(parseAlias('HOST="${HOST:-0.0.0.0}"; PORT="${PORT:-8080}"; ALIAS="${ALIAS:-dsv4-flash}"'))
      .toBe('dsv4-flash')
  })

  it('reads a --alias flag', () => {
    expect(parseAlias('    --alias qwen3.8-unsloth-q8-dflash2 --host 0.0.0.0')).toBe('qwen3.8-unsloth-q8-dflash2')
    expect(parseAlias("--alias 'qwen3.8-hauhau'")).toBe('qwen3.8-hauhau')
  })

  it('reads a bare ALIAS=x assignment', () => {
    expect(parseAlias('ALIAS=ornith-1.5-35b-q8')).toBe('ornith-1.5-35b-q8')
  })

  it('returns undefined for a computed alias', () => {
    expect(parseAlias("exec toolbox run ... --alias '$ALIAS' --host")).toBeUndefined()
    expect(parseAlias('ALIAS=$MODEL_ALIAS')).toBeUndefined()
  })

  it('returns undefined for no alias info or no line', () => {
    expect(parseAlias('set -euo pipefail')).toBeUndefined()
    expect(parseAlias(undefined)).toBeUndefined()
  })
})

describe('parseDiscoverOutput', () => {
  it('parses tab records and skips noise, empty names, and non-comment descriptions', () => {
    const stdout = [
      'run-qwen.sh\t--alias qwen3.8\t# Qwen3.8 model\t/home/u/scripts/run/run-qwen.sh',
      'run-laguna.sh\tALIAS="${ALIAS:-laguna}"\tset -euo pipefail\t/home/u/scripts/run/run-laguna.sh',
      'noise-without-a-tab',
      '\t\t\t',
      'run-x.sh\t\t# desc only',
      '',
    ].join('\n')
    expect(parseDiscoverOutput(stdout)).toEqual([
      { id: 'qwen', scriptPath: '/home/u/scripts/run/run-qwen.sh', alias: 'qwen3.8', description: 'Qwen3.8 model' },
      { id: 'laguna', scriptPath: '/home/u/scripts/run/run-laguna.sh', alias: 'laguna' },
      { id: 'x', scriptPath: '', description: 'desc only' },
    ])
  })

  it('parses the trailing drafter and nudge tag fields', () => {
    const stdout = [
      'run-a.sh\t--alias a\t# A\t/p/run-a.sh\t# drafter: DFlash 2\t# nudge: on',
      'run-b.sh\t--alias b\t# B\t/p/run-b.sh\t\t# nudge: off',
      '',
    ].join('\n')
    expect(parseDiscoverOutput(stdout)).toEqual([
      { id: 'a', scriptPath: '/p/run-a.sh', alias: 'a', description: 'A', drafter: 'DFlash 2', nudge: true },
      { id: 'b', scriptPath: '/p/run-b.sh', alias: 'b', description: 'B', nudge: false },
    ])
  })
})

describe('conciseLocalModelName', () => {
  it('takes the header comment segment before a spaced dash', () => {
    expect(conciseLocalModelName({ id: 'q', description: 'Qwen3.8-27B (unsloth Q8_0) — native MTP self-speculation. Standard' }))
      .toBe('Qwen3.8-27B (unsloth Q8_0)')
  })

  it('takes the first sentence when there is no dash', () => {
    expect(conciseLocalModelName({ id: 'q', description: 'Fast chat model. 8-bit, long context' })).toBe('Fast chat model')
  })

  it('keeps a short comment whole', () => {
    expect(conciseLocalModelName({ id: 'q', description: 'Qwen 3.8B instruct chat' })).toBe('Qwen 3.8B instruct chat')
  })

  it('falls back to the alias, then the id, when no comment', () => {
    expect(conciseLocalModelName({ id: 'q', alias: 'qwen3.8' })).toBe('qwen3.8')
    expect(conciseLocalModelName({ id: 'q' })).toBe('q')
  })

  it('falls back when a present comment has an empty leading segment', () => {
    // A comment that opens with the spaced dash yields an empty head, so the
    // alias (then the id) still wins.
    expect(conciseLocalModelName({ id: 'q', alias: 'qwen3.8', description: ' — MTP only' })).toBe('qwen3.8')
  })
})

describe('parseDrafter', () => {
  it('reads the value after `# drafter:` case-insensitively', () => {
    expect(parseDrafter('# drafter: DFlash 2')).toBe('DFlash 2')
    expect(parseDrafter('#Drafter:  DSpark ')).toBe('DSpark')
  })

  it('is undefined when absent, empty, or not a drafter tag', () => {
    expect(parseDrafter(undefined)).toBeUndefined()
    expect(parseDrafter('# drafter:   ')).toBeUndefined()
    expect(parseDrafter('# notes: whatever')).toBeUndefined()
  })
})

describe('parseNudge', () => {
  it('maps on/off vocabularies to a boolean', () => {
    expect(parseNudge('# nudge: on')).toBe(true)
    expect(parseNudge('# nudge: YES')).toBe(true)
    expect(parseNudge('# nudge: off')).toBe(false)
    expect(parseNudge('# nudge: stock')).toBe(false)
  })

  it('is undefined when absent or unrecognized', () => {
    expect(parseNudge(undefined)).toBeUndefined()
    expect(parseNudge('# nudge: maybe')).toBeUndefined()
    expect(parseNudge('# other: on')).toBeUndefined()
  })
})

describe('localModelDisplayName', () => {
  it('appends the drafter and nudge state to the base name', () => {
    expect(localModelDisplayName({ id: 'q', description: 'Qwen3.8-27B (unsloth Q8_0) — MTP', drafter: 'DFlash 2', nudge: true }))
      .toBe('Qwen3.8-27B (unsloth Q8_0) · DFlash 2 · nudge')
  })

  it('marks nudge off and omits an absent drafter', () => {
    expect(localModelDisplayName({ id: 'q', description: 'Laguna-S', nudge: false })).toBe('Laguna-S · no nudge')
  })

  it('is just the base when neither tag is present', () => {
    expect(localModelDisplayName({ id: 'q', description: 'DeepSeek R1 distill' })).toBe('DeepSeek R1 distill')
  })
})

describe('discover', () => {
  it('runs the discovery command and returns parsed scripts', async () => {
    const calls: string[][] = []
    const scripts = await discover(
      runnerOf({ exitCode: 0, stdout: 'run-a.sh\t--alias a\t# A\t/p/run-a.sh\n', stderr: '' }, calls),
      CFG,
    )
    expect(scripts).toEqual([{ id: 'a', scriptPath: '/p/run-a.sh', alias: 'a', description: 'A' }])
    expect(calls[0]?.slice(0, 2)).toEqual(['ssh', 'dashi'])
    expect(calls[0]?.[2]).toContain('run-*.sh')
  })

  it('rejects an unsafe scripts directory before running anything', async () => {
    await expect(discover(runnerOf({ exitCode: 0, stdout: '', stderr: '' }), { ...CFG, scriptsDir: '$(danger)' }))
      .rejects.toThrow('unsafe scripts directory')
  })

  it('maps ssh, missing-dir, and other non-zero exits to distinct errors', async () => {
    await expect(discover(runnerOf({ exitCode: 255, stdout: '', stderr: 'Permission denied' }), CFG))
      .rejects.toThrow('ssh to dashi failed: Permission denied')
    await expect(discover(runnerOf({ exitCode: 255, stdout: '', stderr: '' }), CFG))
      .rejects.toThrow('connection error')
    await expect(discover(runnerOf({ exitCode: 3, stdout: '', stderr: '' }), CFG))
      .rejects.toThrow('scripts directory not found')
    await expect(discover(runnerOf({ exitCode: 2, stdout: '', stderr: 'boom' }), CFG))
      .rejects.toThrow('discovery failed (exit 2): boom')
  })
})

describe('startScript', () => {
  it('launches a run script detached', async () => {
    const calls: string[][] = []
    await startScript(runnerOf({ exitCode: 0, stdout: 'started', stderr: '' }, calls), CFG, 'qwen')
    expect(calls[0]?.[2]).toContain('setsid nohup ./run-qwen.sh')
    expect(calls[0]?.[2]).toContain('./qwen.serverlog')
  })

  it('rejects an unsafe id or directory', async () => {
    await expect(startScript(runnerOf({ exitCode: 0, stdout: '', stderr: '' }), CFG, 'a;b'))
      .rejects.toThrow('unsafe model id')
    await expect(startScript(runnerOf({ exitCode: 0, stdout: '', stderr: '' }), { ...CFG, scriptsDir: 'a b' }, 'qwen'))
      .rejects.toThrow('unsafe scripts directory')
  })

  it('maps a missing script and other failures to errors', async () => {
    await expect(startScript(runnerOf({ exitCode: 4, stdout: '', stderr: '' }), CFG, 'ghost'))
      .rejects.toThrow('no run script for "ghost"')
    await expect(startScript(runnerOf({ exitCode: 255, stdout: '', stderr: 'down' }), CFG, 'qwen'))
      .rejects.toThrow('ssh to dashi failed')
    await expect(startScript(runnerOf({ exitCode: 5, stdout: '', stderr: 'oops' }), CFG, 'qwen'))
      .rejects.toThrow('start of "qwen" failed (exit 5): oops')
  })
})

describe('stopServer', () => {
  it('treats success and pkill-no-match as stopped', async () => {
    await expect(stopServer(runnerOf({ exitCode: 0, stdout: '', stderr: '' }), CFG)).resolves.toBeUndefined()
    await expect(stopServer(runnerOf({ exitCode: 1, stdout: '', stderr: '' }), CFG)).resolves.toBeUndefined()
  })

  it('maps ssh failure and other exits to errors', async () => {
    await expect(stopServer(runnerOf({ exitCode: 255, stdout: '', stderr: '' }), CFG))
      .rejects.toThrow('ssh to dashi failed')
    await expect(stopServer(runnerOf({ exitCode: 2, stdout: '', stderr: 'nope' }), CFG))
      .rejects.toThrow('stop failed (exit 2): nope')
  })
})

describe('createSubprocessRunner', () => {
  it('spawns, forwards the signal, and reads collected output', async () => {
    let captured: SubprocessSpawnSpec | undefined
    const ctx = {
      subprocess: {
        spawn(spec: SubprocessSpawnSpec) {
          captured = spec
          return fakeHandle('out', 'err', 0)
        },
      },
    } as unknown as Context
    const signal = new AbortController().signal
    const result = await createSubprocessRunner(ctx, () => 5_000).run(['ssh', 'h', 'cmd'], signal)
    expect(result).toEqual({ exitCode: 0, stdout: 'out', stderr: 'err' })
    expect(captured?.argv).toEqual(['ssh', 'h', 'cmd'])
    expect(captured?.graceMs).toBe(5_000)
    expect(captured?.signal).toBe(signal)
    expect(captured?.cwd).toBe(process.cwd())
  })

  it('defaults absent collected streams to empty and omits an unset signal', async () => {
    let captured: SubprocessSpawnSpec | undefined
    const ctx = {
      subprocess: {
        spawn(spec: SubprocessSpawnSpec) {
          captured = spec
          return fakeHandle(undefined, undefined, 1)
        },
      },
    } as unknown as Context
    const result = await createSubprocessRunner(ctx, () => 1_000).run(['ssh'])
    expect(result).toEqual({ exitCode: 1, stdout: '', stderr: '' })
    expect(captured !== undefined && 'signal' in captured).toBe(false)
  })
})

/** Stub `fetch` with per-path canned responses; a route returning null throws (network failure). */
function stubFetch(health: Response | null, models: Response | null): ReturnType<typeof vi.fn> {
  const mock = vi.fn((input: string) => {
    const response = input.endsWith('/health') ? health : models
    return response === null ? Promise.reject(new TypeError('refused')) : Promise.resolve(response)
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('probeStatus', () => {
  it('reports the served id from /v1/models data', async () => {
    stubFetch(ok({ status: 'ok' }), ok({ data: [{ id: 'qwen3.8-unsloth-q8-dflash2' }] }))
    expect(await probeStatus(CFG)).toEqual({ runningAlias: 'qwen3.8-unsloth-q8-dflash2', healthy: true })
  })

  it('reports the served id from the legacy models[].name shape', async () => {
    stubFetch(ok({ status: 'ok' }), ok({ models: [{ name: 'ornith' }] }))
    expect(await probeStatus(CFG)).toEqual({ runningAlias: 'ornith', healthy: true })
  })

  it('is healthy with a null id when the model list is unreadable or wrong-shaped', async () => {
    const controller = new AbortController()
    stubFetch(ok({ status: 'ok' }), new Response('nope', { status: 500 }))
    expect(await probeStatus(CFG, controller.signal)).toEqual({ runningAlias: null, healthy: true })

    stubFetch(ok({ status: 'ok' }), null)
    expect(await probeStatus(CFG)).toEqual({ runningAlias: null, healthy: true })

    stubFetch(ok({ status: 'ok' }), ok(42))
    expect(await probeStatus(CFG)).toEqual({ runningAlias: null, healthy: true })

    stubFetch(ok({ status: 'ok' }), ok({ data: 'not-an-array' }))
    expect(await probeStatus(CFG)).toEqual({ runningAlias: null, healthy: true })

    stubFetch(ok({ status: 'ok' }), ok({ data: [{ noId: true }], models: [{ noName: true }] }))
    expect(await probeStatus(CFG)).toEqual({ runningAlias: null, healthy: true })
  })

  it('is unhealthy when /health is down or unreachable', async () => {
    stubFetch(new Response('loading', { status: 503 }), ok({ data: [] }))
    expect(await probeStatus(CFG)).toEqual({ runningAlias: null, healthy: false })

    stubFetch(null, null)
    expect(await probeStatus(CFG)).toEqual({ runningAlias: null, healthy: false })
  })
})
