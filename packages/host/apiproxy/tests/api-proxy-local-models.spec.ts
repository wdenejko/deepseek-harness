/**
 * localModels domain of the host ApiProxy: `list` returns a null catalog when
 * the `ctx.localModels` seam is not mounted (the opt-in-absent signal) and the
 * seam's catalog when it is; `start`/`stop` acknowledge or surface the seam's
 * transport failure, and are `local-models-error` when the seam is absent.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-local-models'
import type { LocalModelCatalog } from '@deepseek-ai/dsh-local-models/types'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'

const CATALOG: LocalModelCatalog = {
  providerId: 'local',
  route: { provider: 'local', model: 'qwen' },
  running: 'a',
  models: [{ id: 'a', name: 'A', runState: 'running', scriptPath: '/p/run-a.sh' }],
}

/** A fake seam recording start ids; each method can be made to reject. */
function fakeSeam(overrides: {
  list?: () => Promise<LocalModelCatalog>
  start?: (id: string) => Promise<void>
  stop?: () => Promise<void>
} = {}): { starts: string[]; stops: number; service: unknown } {
  const starts: string[] = []
  const counters = { stops: 0 }
  const service = {
    list: overrides.list ?? (() => Promise.resolve(CATALOG)),
    start: overrides.start ?? ((id: string) => { starts.push(id); return Promise.resolve() }),
    stop: overrides.stop ?? (() => { counters.stops += 1; return Promise.resolve() }),
  }
  return { starts, get stops() { return counters.stops }, service }
}

async function baseCtx(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  return ctx
}

const api = (ctx: Context) =>
  createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })

const request = <P>(payload: P) => ({ rpcId: RpcId('t'), payload })

describe('localModels.list', () => {
  it('returns a null catalog when the seam is not mounted', async () => {
    const ctx = await baseCtx()
    const response = await api(ctx).localModels.list(request({}))
    expect(response.result).toEqual({ ok: true, value: { catalog: null } })
  })

  it('returns the seam catalog when mounted', async () => {
    const ctx = await baseCtx()
    ctx.provide('localModels', fakeSeam().service as never)
    const response = await api(ctx).localModels.list(request({}))
    expect(response.result).toEqual({ ok: true, value: { catalog: CATALOG } })
  })

  it('surfaces a transport failure as local-models-error', async () => {
    const ctx = await baseCtx()
    ctx.provide('localModels', fakeSeam({ list: () => Promise.reject(new Error('ssh down')) }).service as never)
    const response = await api(ctx).localModels.list(request({}))
    expect(response.result).toMatchObject({ ok: false, error: { code: 'local-models-error', message: 'ssh down' } })
  })
})

describe('localModels.start', () => {
  it('errors when the seam is not mounted', async () => {
    const ctx = await baseCtx()
    const response = await api(ctx).localModels.start(request({ id: 'a' }))
    expect(response.result).toMatchObject({ ok: false, error: { code: 'local-models-error', message: 'local model management is not configured' } })
  })

  it('acknowledges and forwards the id when mounted', async () => {
    const ctx = await baseCtx()
    const seam = fakeSeam()
    ctx.provide('localModels', seam.service as never)
    const response = await api(ctx).localModels.start(request({ id: 'ornith' }))
    expect(response.result).toEqual({ ok: true, value: { ok: true } })
    expect(seam.starts).toEqual(['ornith'])
  })

  it('surfaces a transport failure as local-models-error', async () => {
    const ctx = await baseCtx()
    ctx.provide('localModels', fakeSeam({ start: () => Promise.reject(new Error('boom')) }).service as never)
    const response = await api(ctx).localModels.start(request({ id: 'a' }))
    expect(response.result).toMatchObject({ ok: false, error: { code: 'local-models-error', message: 'boom' } })
  })
})

describe('localModels.stop', () => {
  it('errors when the seam is not mounted', async () => {
    const ctx = await baseCtx()
    const response = await api(ctx).localModels.stop(request({}))
    expect(response.result).toMatchObject({ ok: false, error: { code: 'local-models-error' } })
  })

  it('acknowledges when mounted', async () => {
    const ctx = await baseCtx()
    const seam = fakeSeam()
    ctx.provide('localModels', seam.service as never)
    const response = await api(ctx).localModels.stop(request({}))
    expect(response.result).toEqual({ ok: true, value: { ok: true } })
    expect(seam.stops).toBe(1)
  })

  it('surfaces a transport failure as local-models-error', async () => {
    const ctx = await baseCtx()
    ctx.provide('localModels', fakeSeam({ stop: () => Promise.reject(new Error('kill failed')) }).service as never)
    const response = await api(ctx).localModels.stop(request({}))
    expect(response.result).toMatchObject({ ok: false, error: { code: 'local-models-error', message: 'kill failed' } })
  })
})
