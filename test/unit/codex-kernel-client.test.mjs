import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import http from 'node:http'
import {
  codexKernelPaths,
  streamCodexKernel,
  withCodexKernelExec,
} from '../../src/lib/transport/codex-kernel-client.mjs'
import {
  ensureCodexKernel,
  stopCodexKernel,
  writeCodexKernelConfig,
} from '../../src/lib/transport/codex-kernel-supervisor.mjs'
import fs from 'node:fs'
import os from 'node:os'

const PROXY_ENV_KEYS = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
]
const LOCAL_CODEX = {
  id: 'vm-codex',
  platform: 'openai',
  proxy: { id: 'px-local', scheme: 'local', host: 'local', port: 0 },
}

function setEnv(t, values) {
  const keys = [...new Set([...PROXY_ENV_KEYS, ...Object.keys(values)])]
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
  for (const k of PROXY_ENV_KEYS) delete process.env[k]
  Object.assign(process.env, values)
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })
}
test('codex kernel socket is not worker.sock', () => {
  const exec = {
    homeDir: '/tmp/vms/vm-codex/cli-home',
    vm: { id: 'vm-codex', runtime: {} },
  }
  const paths = codexKernelPaths(exec)
  assert.equal(paths.socketPath, path.join('/tmp/vms/vm-codex/run', 'codex-kernel.sock'))
  const remapped = withCodexKernelExec(exec)
  assert.match(remapped.vm.runtime.worker_socket, /codex-kernel\.sock$/)
})

test('writeCodexKernelConfig writes bound SOCKS proxy', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-'))
  const vm = { id: 'vm-codex', proxy: { url: 'socks5://127.0.0.1:1080' } }
  const written = writeCodexKernelConfig(root, vm, {
    token: 'secret',
    proxyUrl: 'socks5h://127.0.0.1:1080',
    proxyRequired: true,
  })
  const cfg = JSON.parse(fs.readFileSync(written.configPath, 'utf8'))
  assert.equal(cfg.proxy_required, true)
  assert.equal(cfg.proxy_url, 'socks5h://127.0.0.1:1080')
  assert.equal(cfg.socket_path, written.socketPath)
  assert.equal(cfg.internal_token, 'secret')
  assert.equal(cfg.max_request_bytes, 129 * 1024 * 1024)
  fs.rmSync(root, { recursive: true, force: true })
})

test('writeCodexKernelConfig fail-closes proxy_required without a URL', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-'))
  const written = writeCodexKernelConfig(
    root,
    { id: 'vm-codex' },
    { token: 'secret', proxyUrl: '', proxyRequired: true },
  )
  const cfg = JSON.parse(fs.readFileSync(written.configPath, 'utf8'))
  assert.equal(cfg.proxy_required, true)
  assert.equal(cfg.proxy_url, '')
  fs.rmSync(root, { recursive: true, force: true })
})

test('local egress without a deployment proxy is a direct exit', (t) => {
  setEnv(t, {})
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const written = writeCodexKernelConfig(root, LOCAL_CODEX, {
    token: 'secret',
    proxyUrl: 'socks5h://127.0.0.1:1080',
    proxyRequired: true,
  })
  const cfg = JSON.parse(fs.readFileSync(written.configPath, 'utf8'))
  assert.equal(cfg.proxy_required, false)
  assert.equal(cfg.proxy_url, '')
})

test('local egress hands the kernel the deployment proxy and fails closed on it', (t) => {
  setEnv(t, { HTTPS_PROXY: 'http://proxy.test:8443', HTTP_PROXY: 'http://other.test:3128' })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const written = writeCodexKernelConfig(root, LOCAL_CODEX, { token: 'secret', proxyUrl: '', proxyRequired: false })
  const cfg = JSON.parse(fs.readFileSync(written.configPath, 'utf8'))
  assert.equal(cfg.proxy_url, 'http://proxy.test:8443')
  assert.equal(cfg.proxy_required, true)
})

test('codex kernel starts without inherited proxy variables', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const out = path.join(root, 'env.txt')
  const bin = path.join(root, 'fake-kernel')
  fs.writeFileSync(bin, `#!/bin/sh\nenv > "${out}.tmp" && mv "${out}.tmp" "${out}"\n`, { mode: 0o755 })
  setEnv(t, { HTTPS_PROXY: 'http://proxy.test:8443', no_proxy: 'chatgpt.com', KIN_CODEX_KERNEL_BIN: bin })
  const exec = {
    vmId: 'vm-codex',
    homeDir: path.join(root, 'vm-codex', 'cli-home'),
    vm: { id: 'vm-codex', runtime: {} },
  }
  t.after(() => stopCodexKernel('vm-codex'))
  await ensureCodexKernel(exec, { timeoutMs: 300 })
  for (let i = 0; i < 40 && !fs.existsSync(out); i++) await new Promise((r) => setTimeout(r, 50))
  const keys = fs
    .readFileSync(out, 'utf8')
    .split('\n')
    .map((line) => line.split('=')[0])
  assert.ok(keys.includes('KIN_CODEX_KERNEL_BIN'))
  assert.deepEqual(
    keys.filter((k) => /_proxy$/i.test(k)),
    [],
  )
})

const unixTest = process.platform !== 'win32' ? test : test.skip

/** A fake kin-codex-kernel: same socket, token and `event: response` SSE framing. */
async function fakeKernel(t, writeStream) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-stream-'))
  const slot = path.join(root, 'vm-codex')
  const runDir = path.join(slot, 'run')
  fs.mkdirSync(runDir, { recursive: true })
  fs.writeFileSync(path.join(runDir, 'internal.token'), 'internal-test\n', { mode: 0o600 })
  const server = http.createServer(async (req, res) => {
    for await (const _ of req);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-terminal-state': 'verified' })
    await writeStream(res)
    res.end()
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(path.join(runDir, 'codex-kernel.sock'), resolve)
  })
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { vmId: 'vm-codex', homeDir: path.join(slot, 'cli-home'), vm: {} }
}

function sse(event) {
  return `event: response\ndata: ${JSON.stringify(event)}\n\n`
}

const CREATED = { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } }
const ITEM_ADDED = { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_1', type: 'message' } }
const TEXT_DELTA = { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'hi' }
const ITEM_DONE = { type: 'response.output_item.done', output_index: 0, item: { id: 'msg_1', type: 'message' } }
const COMPLETED = {
  type: 'response.completed',
  response: { id: 'resp_1', status: 'completed', model: 'gpt-test', usage: { input_tokens: 7, output_tokens: 2 } },
}

async function runStream(exec) {
  const lines = []
  const result = await streamCodexKernel({
    exec,
    envelope: { body: { model: 'gpt-test', input: 'hi', stream: true }, stream: true, session: {} },
    onEvent: async (line) => lines.push(line),
  })
  return { result, lines }
}

unixTest('a Responses stream that reaches response.completed is delivered', async (t) => {
  const exec = await fakeKernel(t, async (res) => {
    for (const event of [CREATED, ITEM_ADDED, ITEM_DONE, COMPLETED]) res.write(sse(event))
  })
  const { result, lines } = await runStream(exec)
  assert.equal(result.ok, true)
  assert.equal(result.body.id, 'resp_1')
  assert.equal(result.usage.input_tokens, 7)
  assert.equal(result.streamDiagnostics.terminal, 'completed')
  assert.ok(lines.some((line) => line.includes('"response.completed"')))
})

unixTest('a kernel stream that ends after output without a terminal event names the upstream close', async (t) => {
  const exec = await fakeKernel(t, async (res) => {
    for (const event of [CREATED, ITEM_ADDED, ITEM_DONE]) res.write(sse(event))
  })
  const { result, lines } = await runStream(exec)
  assert.equal(result.ok, false)
  assert.equal(result.committed, true)
  assert.equal(result.status, 200)
  assert.equal(result.body.error.code, 'codex_upstream')
  assert.match(result.body.error.message, /before response\.completed/)
  assert.match(result.body.error.message, /response\.output_item\.done/)
  assert.equal(result.streamDiagnostics.terminal, null)
  assert.equal(result.streamDiagnostics.last_event, 'response.output_item.done')
  assert.ok(lines.length > 0)
})

unixTest('a kernel stream that ends before any output is a 502, never a 200', async (t) => {
  const exec = await fakeKernel(t, async (res) => {
    res.write(sse(CREATED))
  })
  const { result, lines } = await runStream(exec)
  assert.equal(result.ok, false)
  assert.equal(result.committed, false)
  assert.equal(result.status, 502)
  assert.equal(result.body.error.code, 'codex_upstream')
  assert.deepEqual(lines, [])
})

for (const output of [false, true]) {
  unixTest(
    `a streamed server_error ${output ? 'after output stays committed' : 'before output stays eligible for failover'}`,
    async (t) => {
      const error = {
        type: 'error',
        error: { type: 'server_error', code: 'server_error', message: 'processing request failed' },
      }
      const exec = await fakeKernel(t, async (res) => {
        for (const event of [CREATED, ...(output ? [ITEM_ADDED, TEXT_DELTA] : []), error]) res.write(sse(event))
      })
      const { result, lines } = await runStream(exec)
      assert.equal(result.ok, false)
      assert.equal(result.committed, output)
      assert.equal(result.status, output ? 200 : 502)
      assert.equal(result.terminalState, 'incomplete')
      assert.equal(result.body.error.code, 'server_error')
      assert.equal(result.streamDiagnostics.terminal, 'error')
      assert.equal(result.streamDiagnostics.last_event, 'error')
      assert.equal(result.streamDiagnostics.committed, output)
      if (output) assert.ok(result.ttftMs != null)
      else assert.equal(result.ttftMs, null)
      if (output) assert.ok(lines.some((line) => line.includes('"code":"server_error"')))
      else assert.deepEqual(lines, [])
    },
  )
}

unixTest('response.failed with no output before it still reaches the client with its code', async (t) => {
  const failed = {
    type: 'response.failed',
    response: { id: 'resp_1', status: 'failed', error: { code: 'context_length_exceeded', message: 'too long' } },
  }
  const exec = await fakeKernel(t, async (res) => {
    for (const event of [CREATED, failed]) res.write(sse(event))
  })
  const { result, lines } = await runStream(exec)
  assert.equal(result.ok, false)
  assert.equal(result.committed, true)
  assert.equal(result.body.error.code, 'context_length_exceeded')
  assert.ok(lines.some((line) => line.includes('"response.failed"')))
})

unixTest('response.completed with no output events is still delivered whole', async (t) => {
  const exec = await fakeKernel(t, async (res) => {
    for (const event of [CREATED, COMPLETED]) res.write(sse(event))
  })
  const { result, lines } = await runStream(exec)
  assert.equal(result.ok, true)
  assert.ok(lines.some((line) => line.includes('"response.created"')))
  assert.ok(lines.some((line) => line.includes('"response.completed"')))
})

unixTest('a multi-byte character split across socket chunks arrives intact', async (t) => {
  const delta = { type: 'response.output_text.delta', output_index: 0, delta: '断流修复' }
  const exec = await fakeKernel(t, async (res) => {
    res.write(sse(CREATED) + sse(ITEM_ADDED))
    const bytes = Buffer.from(sse(delta), 'utf8')
    const cut = bytes.indexOf(Buffer.from('流', 'utf8')) + 1
    res.write(bytes.subarray(0, cut))
    await new Promise((resolve) => setTimeout(resolve, 30))
    res.write(bytes.subarray(cut))
    res.write(sse(COMPLETED))
  })
  const { result, lines } = await runStream(exec)
  assert.equal(result.ok, true)
  const line = lines.find((l) => l.includes('output_text.delta'))
  assert.match(line, /断流修复/)
  assert.doesNotMatch(line, /�/)
})
