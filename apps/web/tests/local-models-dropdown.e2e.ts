// Web e2e scenario for the opt-in local-model lifecycle seam. A real browser
// drives the composer model dropdown's "Local models" section against the
// assembled `ctx.localModels` seam; the seam's ssh transport is a fake local
// executable and its endpoint probe a local HTTP double, so the full
// discover/start/stop lifecycle runs with no real remote host. Zero model
// calls: the section is localModels-domain and settings traffic only.
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const UI_EXPECTED = fileURLToPath(new URL('./snapshots/local-models-dropdown/ui.expected.md', import.meta.url))
const MODE = webSnapshotMode()

// The seam routes every started local server to one real llm selection; this
// scenario supersedes the scaffold's shipped provider group with the section
// and routes to that provider's model, so `select` after a start is routable.
const ROUTE = { provider: 'deepseek-official', model: 'deepseek-v4-flash' } as const

/**
 * A fake `ssh` that stands in for the remote host. It receives
 * `<target> <remoteCommand>`, recognizes the seam's discover/start/stop
 * commands, and records the running alias in a state file shared with the HTTP
 * double. Written at runtime (executable, no committed binary) so the lane has
 * no host dependency.
 */
const FAKE_SSH = `#!/bin/sh
# Fake ssh for the local-models web e2e. Args: <target> <remoteCommand>.
# Shares the running alias with the endpoint double through $E2E_DASHI_STATE.
cmd="$2"
state="$E2E_DASHI_STATE"
case "$cmd" in
  *pkill*)
    rm -f "$state"
    ;;
  *"setsid nohup"*)
    id=$(printf '%s' "$cmd" | sed -n 's|.*nohup ./run-\\(.*\\)\\.sh .*|\\1|p')
    printf '%s' "$id" > "$state"
    echo started
    ;;
  *"for f in"*)
    printf 'run-qwen3.8.sh\\t--alias qwen3.8\\t# Qwen 3.8B instruct chat — 8-bit unsloth build, MTP self-speculation\\t/home/dashi/scripts/run/run-qwen3.8.sh\\t# drafter: DFlash 2\\t# nudge: on\\n'
    printf 'run-llama-70b.sh\\t--alias llama-70b\\t# Llama 3 70B general — Q4_K_M quant, 128k context\\t/home/dashi/scripts/run/run-llama-70b.sh\\t# drafter: DSpark\\t# nudge: off\\n'
    printf 'run-deepseek-r1.sh\\t--alias deepseek-r1\\t# DeepSeek R1 distill — reasoning, Q6_K\\t/home/dashi/scripts/run/run-deepseek-r1.sh\\t\\t\\n'
    ;;
  *)
    echo "fake-ssh: unrecognized command" >&2
    exit 1
    ;;
esac
exit 0
`

/** Start the model-endpoint double: `/health` and `/v1/models` reflect the shared state file. */
function startEndpointDouble(stateFile: string): Promise<{ server: Server; baseURL: string }> {
  const runningAlias = (): string => (existsSync(stateFile) ? readFileSync(stateFile, 'utf8').trim() : '')
  const server = createServer((request, response) => {
    const alias = runningAlias()
    const path = new URL(request.url ?? '', 'http://127.0.0.1').pathname
    if (path === '/health') {
      response.writeHead(alias === '' ? 503 : 200, { 'content-type': 'text/plain' })
      response.end(alias === '' ? 'loading' : 'ok')
      return
    }
    if (path === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: alias === '' ? [] : [{ id: alias }] }))
      return
    }
    response.writeHead(404)
    response.end()
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve({ server, baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })
    })
  })
}

describe('web e2e: opt-in local-model lifecycle dropdown', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let endpoint: Server | undefined
  let fakeHomeDir: string | undefined
  let stateFile: string
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    fakeHomeDir = await mkdtemp(join(tmpdir(), 'dsh-web-e2e-localmodels-'))
    stateFile = join(fakeHomeDir, 'running-alias')
    // One model already serving when the browser opens, so the first render
    // shows a running badge, its Stop control, and two stopped peers.
    await writeFile(stateFile, 'llama-70b')
    const fakeSshPath = join(fakeHomeDir, 'fake-ssh')
    await writeFile(fakeSshPath, FAKE_SSH)
    await chmod(fakeSshPath, 0o755)
    // The endpoint double and the fake ssh share this file; the seam's ssh
    // child inherits E2E_DASHI_STATE through the subprocess env scrub (a
    // non-DSH, non-sensitive key survives it).
    process.env.E2E_DASHI_STATE = stateFile
    const started = await startEndpointDouble(stateFile)
    endpoint = started.server

    scaffold = await launchWebScaffold({
      localModels: {
        execCommand: fakeSshPath,
        scriptsDir: '/home/dashi/scripts/run',
        probeBaseURL: started.baseURL,
        providerId: ROUTE.provider,
        route: ROUTE,
      },
    })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await new Promise<void>((resolve, reject) => {
      if (endpoint === undefined) { resolve(); return }
      endpoint.close((error) => { if (error === undefined) resolve(); else reject(error) })
    })
    Reflect.deleteProperty(process.env, 'E2E_DASHI_STATE')
    if (fakeHomeDir !== undefined) await rm(fakeHomeDir, { recursive: true, force: true })
  })

  // The dropdown shows each entry's composed display name: the header comment's
  // leading segment (the fake discover comments carry a verbose " — " tail the
  // seam trims) followed by the `# drafter:`/`# nudge:` tags — e.g.
  // "Qwen 3.8B instruct chat · DFlash 2 · nudge". The golden captures the full
  // composed names; these locator bases are robust name substrings.
  const QWEN = 'Qwen 3.8B instruct chat'
  const LLAMA = 'Llama 3 70B general'

  /** Ensure the dropdown is open on the model pane, from any prior menu state. */
  const openModelPane = async (): Promise<void> => {
    const trigger = page.getByRole('button', { name: /^Select model/ })
    const menu = page.locator('[role="menu"]')
    // Close any open menu first through the trigger's own toggle: the menu opens
    // upward over the composer, so clicking the textarea to dismiss is
    // intercepted by whichever row overlaps it, but the trigger below the menu
    // stays clickable. Then open fresh and drill into the model pane.
    if (await menu.count() > 0) {
      await trigger.click()
      await menu.waitFor({ state: 'detached', timeout: 5_000 })
    }
    await trigger.click()
    await page.getByRole('menuitem', { name: /^Model/ }).click()
  }

  /** The Local models section's Stop controls, scoped to the open menu. */
  const stopButtonCount = (): Promise<number> =>
    page.locator('[role="menu"]').getByRole('button', { name: /^Stop / }).count()

  it('renders the Local models section with per-entry run-state (golden)', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-local-models-section'))
    await openModelPane()
    // The section loads from the seam on open; wait for the running entry's Stop
    // control so the golden captures the settled state.
    await page.getByRole('button', { name: `Stop ${LLAMA}` }).waitFor({ timeout: 15_000 })
    const snapshot = await captureStableAria(page, '[role="menu"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
  })

  it('starts a stopped model, which supersedes the previously running one', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-local-models-start'))
    await openModelPane()
    await page.getByRole('menuitemradio', { name: QWEN }).click()
    // Starting qwen stops llama (one server at a time). The accepted start
    // closes the menu asynchronously; wait for that detach before reopening so
    // the reopen never races the in-flight close (which would re-toggle it).
    await page.locator('[role="menu"]').waitFor({ state: 'detached', timeout: 15_000 })
    await openModelPane()
    await expect.poll(() => page.getByRole('button', { name: `Stop ${QWEN}` }).count(), { timeout: 15_000 }).toBe(1)
    expect(await page.getByRole('button', { name: `Stop ${LLAMA}` }).count()).toBe(0)
    expect(readFileSync(stateFile, 'utf8').trim()).toBe('qwen3.8')
  })

  it('stops the running model from its Stop control', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-local-models-stop'))
    await openModelPane()
    await page.getByRole('button', { name: `Stop ${QWEN}` }).click()
    // Stop leaves the menu open; the badges settle to all-stopped. The store
    // clears badges optimistically, so poll the shared state file — cleared only
    // once the real stop command reaches the fake host — for the settled truth.
    await expect.poll(stopButtonCount, { timeout: 15_000 }).toBe(0)
    await expect.poll(
      () => (existsSync(stateFile) ? readFileSync(stateFile, 'utf8').trim() : ''),
      { timeout: 15_000 },
    ).toBe('')
  })

  it.skipIf(MODE === 'record')('stayed clean', () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
