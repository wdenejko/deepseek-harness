/** The `ctx.localModels` seam over a fake subprocess and a stubbed endpoint probe. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessOutputReader, SubprocessSpawnSpec, SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import LocalModelManager, { LOCAL_MODELS_SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-local-models'
import type { Config } from '@deepseek-ai/dsh-local-models'

/** Two discovered scripts: `a` (alias, comment, drafter+nudge tags) and `b` (computed alias, untagged). */
const DISCOVER = [
  'run-a.sh\t--alias a-alias\t# Model A\t/p/run-a.sh\t# drafter: DFlash 2\t# nudge: on',
  // `b` has a computed alias and no header comment, so its name falls back to the id.
  'run-b.sh\t\tset -euo pipefail\t/p/run-b.sh',
  '',
].join('\n')

const CONFIG: Config = {
  sshTarget: 'dashi',
  scriptsDir: '~/scripts/run',
  probeBaseURL: 'http://host.test:8080',
  providerId: 'local',
  route: { provider: 'local', model: 'qwen3.8' },
}

/** Remote commands the fake subprocess received this test (argv[2] is the remote shell command). */
const remoteCommands: string[] = []

/** A settled subprocess handle exposing one canned collected stdout. */
function fakeHandle(stdout: string): SubprocessHandle {
  const reader: SubprocessOutputReader = { readFrom: () => ({ text: stdout, nextOffset: stdout.length, lossy: false }) }
  return {
    pid: 1,
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    collected: { stdout: reader, stderr: reader },
    done: Promise.resolve({ exitCode: 0, signal: null }),
    terminate() {},
    waitForExit: () => Promise.resolve(true),
  }
}

/** Fake subprocess: routes the remote command to discovery output, a start ack, or a stop ack. */
class FakeSubprocess extends SubprocessRuntime {
  resolveExecutable(command: string): Promise<string> {
    return Promise.resolve(command)
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const command = spec.argv[2] ?? ''
    remoteCommands.push(command)
    if (command.includes('for f in run-*.sh')) return fakeHandle(DISCOVER)
    return fakeHandle('ok')
  }

  spawnTerminal(): Promise<SubprocessTerminalHandle> {
    return Promise.reject(new Error('unused'))
  }
}

/** Stub `fetch` so `/health` reflects `healthy` and `/v1/models` reports `alias` (or an empty list). */
function setProbe(healthy: boolean, alias: string | null): void {
  vi.stubGlobal('fetch', vi.fn((input: string) => {
    if (input.endsWith('/health')) {
      return Promise.resolve(new Response(healthy ? 'ok' : 'loading', { status: healthy ? 200 : 503 }))
    }
    const body = alias === null ? { data: [] } : { data: [{ id: alias }] }
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }))
  }))
}

async function boot(override: Partial<Config> = {}): Promise<{ ctx: Context; fiber: Fiber }> {
  const ctx = new Context()
  const subprocessFiber = ctx.plugin(FakeSubprocess)
  await subprocessFiber.await()
  const fiber = ctx.plugin(LocalModelManager, { ...CONFIG, ...override })
  await fiber.await()
  return { ctx, fiber }
}

afterEach(() => {
  vi.unstubAllGlobals()
  remoteCommands.length = 0
})

describe('list', () => {
  it('lists discovered scripts and marks the served one running', async () => {
    setProbe(true, 'a-alias')
    const { ctx } = await boot()
    const catalog = await ctx.localModels.list()
    expect(catalog.providerId).toBe('local')
    expect(catalog.route).toEqual({ provider: 'local', model: 'qwen3.8' })
    expect(catalog.running).toBe('a')
    expect(catalog.models).toEqual([
      { id: 'a', name: 'Model A · DFlash 2 · nudge', alias: 'a-alias', description: 'Model A', scriptPath: '/p/run-a.sh', runState: 'running' },
      { id: 'b', name: 'b', scriptPath: '/p/run-b.sh', runState: 'stopped' },
    ])
    await ctx.fiber.dispose()
  })

  it('marks every model stopped when the endpoint is down', async () => {
    setProbe(false, null)
    const { ctx } = await boot()
    const catalog = await ctx.localModels.list()
    expect(catalog.running).toBeNull()
    expect(catalog.models.map(model => model.runState)).toEqual(['stopped', 'stopped'])
    await ctx.fiber.dispose()
  })
})

describe('status', () => {
  it('exposes the raw endpoint probe', async () => {
    setProbe(true, 'a-alias')
    const { ctx } = await boot()
    expect(await ctx.localModels.status()).toEqual({ runningAlias: 'a-alias', healthy: true })
    await ctx.fiber.dispose()
  })
})

describe('start', () => {
  it('stops the current server, launches the chosen one, and reports starting', async () => {
    setProbe(true, 'a-alias')
    const { ctx } = await boot()
    const events: number[] = []
    ctx.on('localModels/state-changed', () => { events.push(1) })
    remoteCommands.length = 0

    await ctx.localModels.start('b')
    expect(remoteCommands.some(command => command.includes('pkill'))).toBe(true)
    expect(remoteCommands.some(command => command.includes('setsid nohup ./run-b.sh'))).toBe(true)
    expect(events.length).toBe(1)

    setProbe(false, null)
    const catalog = await ctx.localModels.list()
    expect(catalog.running).toBeNull()
    expect(catalog.models.find(model => model.id === 'b')?.runState).toBe('starting')
    await ctx.fiber.dispose()
  })

  it('skips the stop when the endpoint is already down', async () => {
    setProbe(false, null)
    const { ctx } = await boot()
    remoteCommands.length = 0
    await ctx.localModels.start('a')
    expect(remoteCommands.some(command => command.includes('pkill'))).toBe(false)
    expect(remoteCommands.some(command => command.includes('setsid nohup ./run-a.sh'))).toBe(true)
    await ctx.fiber.dispose()
  })

  it('clears the pending start once the endpoint serves it', async () => {
    setProbe(false, null)
    const { ctx } = await boot()
    await ctx.localModels.start('a')
    setProbe(true, 'a-alias')
    const catalog = await ctx.localModels.list()
    expect(catalog.running).toBe('a')
    expect(catalog.models.find(model => model.id === 'a')?.runState).toBe('running')
    await ctx.fiber.dispose()
  })

  it('attributes an unmatched or unreadable served model to the last started one', async () => {
    setProbe(false, null)
    const { ctx } = await boot()
    await ctx.localModels.start('b')

    // Healthy but the served alias matches no script: fall back to the pending id.
    setProbe(true, 'mystery-alias')
    expect((await ctx.localModels.list()).running).toBe('b')

    // Pending is now cleared; a healthy-but-unreadable list falls back to lastStartedId.
    setProbe(true, null)
    expect((await ctx.localModels.list()).running).toBe('b')
    await ctx.fiber.dispose()
  })

  it('reverts a stuck start to stopped after the start budget elapses', async () => {
    setProbe(false, null)
    const { ctx } = await boot({ startTimeoutMs: 0 })
    await ctx.localModels.start('a')
    const catalog = await ctx.localModels.list()
    expect(catalog.running).toBeNull()
    expect(catalog.models.find(model => model.id === 'a')?.runState).toBe('stopped')
    await ctx.fiber.dispose()
  })

  it('rejects an unsafe model id before touching the endpoint', async () => {
    const { ctx } = await boot()
    await expect(ctx.localModels.start('a;rm -rf')).rejects.toThrow('unknown or unsafe model id')
    await ctx.fiber.dispose()
  })
})

describe('stop', () => {
  it('stops the server, clears attribution, and announces the change', async () => {
    setProbe(true, 'a-alias')
    const { ctx } = await boot()
    await ctx.localModels.start('a')
    const events: number[] = []
    ctx.on('localModels/state-changed', () => { events.push(1) })
    remoteCommands.length = 0

    await ctx.localModels.stop()
    expect(remoteCommands.some(command => command.includes('pkill'))).toBe(true)
    expect(events.length).toBe(1)

    setProbe(false, null)
    expect((await ctx.localModels.list()).running).toBeNull()
    await ctx.fiber.dispose()
  })
})

describe('plugin registration', () => {
  it('registers ctx.localModels and releases it on dispose', async () => {
    setProbe(false, null)
    const { ctx, fiber } = await boot()
    expect(ctx.get('localModels')).toBeDefined()
    await fiber.dispose()
    expect(ctx.get('localModels')).toBeUndefined()
    await ctx.fiber.dispose()
  })
})

/** The smallest real settings provider: one in-memory document, always writable. */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

describe('settings section', () => {
  it('serves a stored endpoint to the next operation and releases the namespace on unload', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeSubprocess).await()
    ctx.plugin(MemorySettings)
    const pluginFiber = ctx.plugin(LocalModelManager, CONFIG)
    await pluginFiber.await()

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(new Response('loading', { status: 503 })))
    await ctx.localModels.status()
    expect(fetchSpy.mock.calls[0]?.[0] as string).toContain('http://host.test:8080/health')

    await ctx.settings.update(LOCAL_MODELS_SETTINGS_NAMESPACE, { probeBaseURL: 'http://moved.test:9090' })
    fetchSpy.mockClear()
    await ctx.localModels.status()
    expect(fetchSpy.mock.calls[0]?.[0] as string).toContain('http://moved.test:9090/health')

    expect(ctx.settings.describe().map(row => String(row.ns))).toContain('local-models')
    await pluginFiber.dispose()
    expect(ctx.settings.describe().map(row => String(row.ns))).not.toContain('local-models')
    await ctx.fiber.dispose()
  })
})
