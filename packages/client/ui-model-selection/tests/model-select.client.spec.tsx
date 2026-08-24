// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LocalModelCatalog, ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { ComponentProps } from 'react'
import type { ModelDirectoryState } from '../src/client/directory.ts'
import { ModelSelect } from '../src/client/ModelSelect.tsx'
import { zh } from '../src/client/locales.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'

// The seat's key domain is model ∪ common; the stub mirrors the real lookup
// chain: package dictionary, then common vocabulary, then the key.
const t: ComponentProps<typeof ModelSelect>['t'] = (key, params) => {
  const template = (zh as Record<string, string>)[key]
    ?? (commonZh as Record<string, string>)[key]
    ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

const reasoning = {
  efforts: [
    { id: 'off', name: 'Off' },
    { id: 'high', name: 'High' },
    { id: 'max', name: 'Max', description: 'Largest budget' },
  ],
  defaultEffort: 'high',
}

function state(overrides: Partial<ModelDirectoryState> = {}): ModelDirectoryState {
  return {
    current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    routable: true,
    groups: [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning }],
    }],
    failures: [],
    status: 'ready',
    error: null,
    local: null,
    localError: null,
    ...overrides,
  }
}

type Props = ComponentProps<typeof ModelSelect>

/** Render with the required injected props defaulted; overrides win. */
function renderSelect(overrides: Partial<Props> = {}): { props: Props; directory: SnapshotStore<ModelDirectoryState> } {
  const directory = overrides.directory ?? createSnapshotStore<ModelDirectoryState>(state())
  const props: Props = {
    locked: false,
    available: true,
    directory,
    load: vi.fn(),
    loadLocal: vi.fn(),
    select: vi.fn().mockResolvedValue(true),
    startLocal: vi.fn().mockResolvedValue(true),
    stopLocal: vi.fn().mockResolvedValue(true),
    t,
    ...overrides,
  }
  render(<ModelSelect {...props} />)
  return { props, directory }
}

/** A three-model local catalog: running, stopped, and starting. */
const LOCAL: LocalModelCatalog = {
  providerId: 'local',
  route: { provider: 'local', model: 'qwen' },
  running: 'qwen-q8',
  models: [
    { id: 'qwen-q8', name: 'Qwen Q8', runState: 'running', scriptPath: '/p/run-qwen-q8.sh' },
    { id: 'ornith', name: 'Ornith', runState: 'stopped', scriptPath: '/p/run-ornith.sh' },
    { id: 'laguna', name: 'Laguna', runState: 'starting', scriptPath: '/p/run-laguna.sh' },
  ],
}

/** Open the trigger and drill into the model list pane. */
function openModelPane(): void {
  fireEvent.click(screen.getByRole('button'))
  fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
}

afterEach(cleanup)

describe('ModelSelect reasoning effort', () => {
  it('renders adapter metadata and submits the effort as part of the session selection', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state())
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.set(state({ current: selection }))
      return true
    })
    renderSelect({ directory, select })

    const trigger = screen.getByRole('button', {
      name: '选择模型，当前 DeepSeek-V4-Flash，推理等级 High',
    })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['Off', 'High', 'MaxLargest budget'])

    fireEvent.click(screen.getByRole('menuitemradio', { name: /Max/ }))
    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'max',
      })
      expect(trigger.getAttribute('aria-label')).toBe('选择模型，当前 DeepSeek-V4-Flash，推理等级 Max')
    })
  })

  it('offers provider default only when the adapter does not configure a model default', () => {
    const directory = createSnapshotStore(state({
      groups: [{
        id: 'provider',
        name: 'Provider',
        models: [{
          id: 'model',
          name: 'Model',
          reasoning: { efforts: [{ id: 'standard', name: 'Standard' }] },
        }],
      }],
      current: { provider: 'provider', model: 'model' },
    }))
    renderSelect({ directory })

    fireEvent.click(screen.getByRole('button', {
      name: '选择模型，当前 Model，推理等级 Default',
    }))
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['Default', 'Standard'])
  })

  it('prompts for a selection when the current model is no longer advertised', () => {
    const directory = createSnapshotStore(state({
      current: { provider: 'deepseek-official', model: 'removed-model' },
    }))
    renderSelect({ directory })

    const trigger = screen.getByRole('button', { name: '选择模型' })
    expect(trigger.textContent).toContain('选择模型')
    fireEvent.click(trigger)
    expect(screen.queryByRole('menuitem', { name: /推理等级/ })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
    expect(screen.queryByText('removed-model')).toBeNull()
    expect(screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' })).toBeTruthy()
  })

  it('announces a rejected selection as a transient toast and keeps the in-menu strip for loads', async () => {
    const groups = [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
      ],
    }]
    const directory = createSnapshotStore<ModelDirectoryState>(state({ groups }))
    const select = vi.fn(async () => {
      directory.set(state({ groups, status: 'error', error: 'model-unavailable: session already contains images' }))
      return false
    })
    renderSelect({ directory, select })

    fireEvent.click(screen.getByRole('button', { name: /选择模型|当前/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /DeepSeek-V4-Pro/ }))
    const toast = await screen.findByRole('alert')
    expect(toast.textContent).toContain('模型操作失败：model-unavailable: session already contains images')
    // The selection failure does not render the in-menu load strip (no Retry).
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
  })

  it('renders no Agent-bound control for an addressed subagent session', () => {
    const load = vi.fn()
    renderSelect({ available: false, load })

    expect(screen.queryByRole('button')).toBeNull()
    expect(load).not.toHaveBeenCalled()
  })
})

describe('ModelSelect local models', () => {
  it('renders the local section with run-state badges and marks the running one current', () => {
    renderSelect({ directory: createSnapshotStore(state({ local: LOCAL })) })
    openModelPane()
    expect(screen.getByText('本地模型')).toBeTruthy()
    expect(screen.getByRole('menuitemradio', { name: /Qwen Q8/ }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText('运行中')).toBeTruthy()
    expect(screen.getByText('已停止')).toBeTruthy()
    expect(screen.getByText('启动中…')).toBeTruthy()
  })

  it('supersedes the plain local provider group with the lifecycle section', () => {
    const groups = [
      { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'x', name: 'X' }] },
      { id: 'local', name: 'Local (raw)', models: [{ id: 'qwen', name: 'Raw Qwen' }] },
    ]
    renderSelect({ directory: createSnapshotStore(state({ groups, local: LOCAL, current: { provider: 'deepseek-official', model: 'x' } })) })
    openModelPane()
    expect(screen.queryByText('Local (raw)')).toBeNull()
    expect(screen.queryByRole('menuitemradio', { name: 'Raw Qwen' })).toBeNull()
    expect(screen.getByText('本地模型')).toBeTruthy()
  })

  it('starts a stopped local model on click', async () => {
    const startLocal = vi.fn().mockResolvedValue(true)
    renderSelect({ directory: createSnapshotStore(state({ local: LOCAL })), startLocal })
    openModelPane()
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Ornith/ }))
    await waitFor(() => { expect(startLocal).toHaveBeenCalledWith('ornith') })
  })

  it('does not restart the already-running local model', () => {
    const startLocal = vi.fn().mockResolvedValue(true)
    renderSelect({ directory: createSnapshotStore(state({ local: LOCAL })), startLocal })
    openModelPane()
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Qwen Q8/ }))
    expect(startLocal).not.toHaveBeenCalled()
  })

  it('disables a starting local model row', () => {
    renderSelect({ directory: createSnapshotStore(state({ local: LOCAL })) })
    openModelPane()
    expect(screen.getByRole('menuitemradio', { name: /Laguna/ }).hasAttribute('disabled')).toBe(true)
  })

  it('stops the running local model from its Stop control', async () => {
    const stopLocal = vi.fn().mockResolvedValue(true)
    renderSelect({ directory: createSnapshotStore(state({ local: LOCAL })), stopLocal })
    openModelPane()
    fireEvent.click(screen.getByRole('button', { name: '停止 Qwen Q8' }))
    await waitFor(() => { expect(stopLocal).toHaveBeenCalled() })
  })

  it('announces a rejected local start as a toast', async () => {
    const directory = createSnapshotStore(state({ local: LOCAL }))
    const startLocal = vi.fn(async () => {
      directory.set(state({ local: LOCAL, localError: 'local-models-error: ssh down' }))
      return false
    })
    renderSelect({ directory, startLocal })
    openModelPane()
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Ornith/ }))
    const toast = await screen.findByRole('alert')
    expect(toast.textContent).toContain('模型操作失败：local-models-error: ssh down')
  })

  it('announces a rejected local stop as a toast', async () => {
    const directory = createSnapshotStore(state({ local: LOCAL }))
    const stopLocal = vi.fn(async () => {
      directory.set(state({ local: LOCAL, localError: 'local-models-error: kill failed' }))
      return false
    })
    renderSelect({ directory, stopLocal })
    openModelPane()
    fireEvent.click(screen.getByRole('button', { name: '停止 Qwen Q8' }))
    const toast = await screen.findByRole('alert')
    expect(toast.textContent).toContain('kill failed')
  })

  it('renders a local error strip inside the section', () => {
    renderSelect({ directory: createSnapshotStore(state({ local: LOCAL, localError: 'local-models-error: probe failed' })) })
    openModelPane()
    expect(screen.getByText('模型操作失败：local-models-error: probe failed')).toBeTruthy()
  })

  it('labels the trigger with the running local model when on the local route', () => {
    renderSelect({ directory: createSnapshotStore(state({ local: LOCAL, current: { provider: 'local', model: 'qwen' } })) })
    expect(screen.getByRole('button', { name: '选择模型，当前 Qwen Q8' })).toBeTruthy()
  })

  it('falls back to the model label on the local route with nothing running', () => {
    const stoppedLocal: LocalModelCatalog = {
      ...LOCAL,
      running: null,
      models: LOCAL.models.map(model => ({ ...model, runState: 'stopped' })),
    }
    renderSelect({ directory: createSnapshotStore(state({ local: stoppedLocal, current: { provider: 'local', model: 'qwen' } })) })
    // No matching catalog choice, so the trigger shows the unset select label.
    expect(screen.getByRole('button', { name: '选择模型' })).toBeTruthy()
  })

  it('polls the local catalog while a model is starting', () => {
    vi.useFakeTimers()
    try {
      const loadLocal = vi.fn()
      renderSelect({ directory: createSnapshotStore(state({ local: LOCAL })), loadLocal })
      fireEvent.click(screen.getByRole('button'))
      loadLocal.mockClear()
      act(() => { vi.advanceTimersByTime(3_000) })
      expect(loadLocal).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows the empty state when neither groups nor local models exist', () => {
    renderSelect({ directory: createSnapshotStore(state({ groups: [], local: null, current: null })) })
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
    expect(screen.getByText('没有可用的模型。')).toBeTruthy()
  })

  it('shows the empty state when the local seam reports no models', () => {
    const emptyLocal: LocalModelCatalog = { providerId: 'local', route: { provider: 'local', model: 'qwen' }, running: null, models: [] }
    renderSelect({ directory: createSnapshotStore(state({ groups: [], local: emptyLocal, current: null })) })
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
    expect(screen.getByText('没有可用的模型。')).toBeTruthy()
  })
})
