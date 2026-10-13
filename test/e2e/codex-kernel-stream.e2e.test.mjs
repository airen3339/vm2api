import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { writeCodexKernelConfig } from '../../src/lib/transport/codex-kernel-supervisor.mjs'

const binary = process.env.KIN_CODEX_KERNEL_BIN || path.resolve('bin/kin-codex-kernel')

function request(socketPath, token, endpoint, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body))
    let response = null
    let requestError = null
    const req = http.request(
      {
        socketPath,
        path: endpoint,
        method: body ? 'POST' : 'GET',
        headers: {
          'x-internal-token': token,
          'content-type': 'application/json',
          ...(payload ? { 'content-length': payload.length } : {}),
        },
        timeout: 5000,
      },
      (res) => {
        response = res
        let text = ''
        res.on('data', (chunk) => {
          text += chunk
        })
        res.on('end', () => resolve({ status: res.statusCode, text, requestError }))
        res.on('error', reject)
      },
    )
    req.on('error', (error) => {
      requestError = error
      if (!response) reject(error)
    })
    req.on('timeout', () => req.destroy(new Error('fixture timeout')))
    req.end(payload)
  })
}

async function fixture(
  t,
  events,
  input = 'fixture',
  { maxRequestBytes, expectedStatus = 200, expectedUpstreamCalls = 1 } = {},
) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-codex-stream-'))
  let httpCalls = 0
  const upstream = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/responses') return res.writeHead(404).end()
    httpCalls++
    req.resume()
    await new Promise((resolve) => req.once('end', resolve))
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    res.end()
  })
  const ws = new WebSocketServer({ server: upstream })
  let connects = 0
  ws.on('connection', (socket) => {
    connects++
    socket.once('message', () => {
      let index = 0
      const send = () => {
        if (socket.readyState !== 1) return
        if (index === events.length) return socket.close()
        socket.send(JSON.stringify(events[index++]))
        setTimeout(send, 10)
      }
      send()
    })
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${upstream.address().port}`
  const projectRoot = temp
  const credentialPath = path.join(projectRoot, 'vms', 'fixture', 'codex-credentials.json')
  fs.mkdirSync(path.dirname(credentialPath), { recursive: true })
  fs.writeFileSync(
    credentialPath,
    JSON.stringify({
      accounts: [
        {
          id: 'fixture',
          access_token: 'fixture-only',
          refresh_token: '',
          expires_at: Date.now() + 86400000,
          chatgpt_account_id: 'fixture-account',
          rpm: 0,
          max_concurrency: 1,
        },
      ],
    }),
    { mode: 0o600 },
  )
  const written = writeCodexKernelConfig(projectRoot, { id: 'fixture' }, { token: 'isolated-fixture-token' })
  const config = JSON.parse(fs.readFileSync(written.configPath, 'utf8'))
  config.oauth_token_url = `${base}/oauth/token`
  config.chatgpt_base_url = base
  config.test_endpoints = true
  if (maxRequestBytes != null) config.max_request_bytes = maxRequestBytes
  fs.writeFileSync(written.configPath, JSON.stringify(config), { mode: 0o600 })
  const { socketPath, configPath } = written
  const token = fs.readFileSync(written.tokenPath, 'utf8').trim()
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(https?|all|no)_proxy$/i.test(key)))
  const child = spawn(binary, [configPath], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let diagnostic = ''
  child.stderr.on('data', (chunk) => {
    diagnostic += chunk
  })
  t.after(async () => {
    const exit = child.exitCode == null && child.signalCode == null ? once(child, 'exit') : null
    if (exit) {
      child.kill('SIGTERM')
      await exit
    }
    for (const socket of ws.clients) socket.terminate()
    ws.close()
    await new Promise((resolve) => upstream.close(resolve))
    fs.rmSync(temp, { recursive: true, force: true })
  })
  const deadline = Date.now() + 3000
  for (;;) {
    try {
      const health = await request(socketPath, token, '/internal/health')
      if (health.status === 200) break
    } catch {}
    assert.ok(Date.now() < deadline, `kernel did not start: ${diagnostic.slice(-400)}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const result = await request(socketPath, token, '/internal/v1/codex/responses', {
    transport: 'websocket',
    headers: { 'x-openai-internal-codex-responses-lite': 'true', 'openai-beta': 'responses_websockets=2026-02-06' },
    body: {
      model: 'gpt-6.1-sol',
      stream: true,
      store: false,
      parallel_tool_calls: false,
      include: ['reasoning.encrypted_content'],
      reasoning: { context: 'all_turns' },
      input: [{ role: 'user', content: input }],
    },
    stream: true,
    session: { session_id: 'fixture-session' },
  })
  if (result.requestError) {
    const toleratedEarlyReject =
      expectedStatus === 413 && result.status === 413 && ['EPIPE', 'ECONNRESET'].includes(result.requestError.code)
    assert.ok(
      toleratedEarlyReject,
      `unexpected request transport error: ${result.requestError.code || result.requestError.message}`,
    )
  }
  assert.equal(
    connects + httpCalls,
    expectedUpstreamCalls,
    `request must stay on the isolated upstream: ${result.text.slice(0, 300)}`,
  )
  assert.equal(result.status, expectedStatus)
  return result.text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice(5).trim()))
}

const created = { type: 'response.created', response: { id: 'resp_fixture', status: 'in_progress', output: [] } }
const completed = {
  type: 'response.completed',
  response: {
    id: 'resp_fixture',
    status: 'completed',
    output: [],
    usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
  },
}

test('long-session request larger than 4 MiB stays within the configured body budget', {
  timeout: 10000,
}, async (t) => {
  const events = await fixture(t, [created, completed], 'x'.repeat(5 * 1024 * 1024))
  assert.equal(events.at(-1).type, 'response.completed')
})

test('request larger than 32 MiB stays within the configured 129 MiB body budget', { timeout: 30000 }, async (t) => {
  const events = await fixture(t, [created, completed], 'x'.repeat(40 * 1024 * 1024))
  assert.equal(events.at(-1).type, 'response.completed')
})

test('request above an explicit lower body limit is rejected before any upstream connect', {
  timeout: 10000,
}, async (t) => {
  const events = await fixture(t, [created, completed], 'x'.repeat(65 * 1024), {
    maxRequestBytes: 64 * 1024,
    expectedStatus: 413,
    expectedUpstreamCalls: 0,
  })
  assert.deepEqual(events, [])
})

for (const [name, done] of [
  [
    'large custom tool input',
    {
      type: 'response.custom_tool_call_input.done',
      output_index: 0,
      item_id: 'call_fixture',
      input: 'x'.repeat(128 * 1024) + ' response.completed response.failed "status_code":429 ' + 'y'.repeat(128 * 1024),
    },
  ],
  [
    'output text',
    {
      type: 'response.output_text.done',
      output_index: 0,
      item_id: 'msg_fixture',
      content_index: 0,
      text: 'Documentation explains response.completed and response.failed, not a real terminal event.',
    },
  ],
]) {
  test(`${name} containing terminal words does not terminate the Codex stream`, { timeout: 10000 }, async (t) => {
    const itemDone = {
      type: 'response.output_item.done',
      output_index: 0,
      item: { id: 'item_fixture', status: 'completed' },
    }
    const events = await fixture(t, [created, done, itemDone, completed])
    assert.deepEqual(
      events.map((event) => event.type),
      [created.type, done.type, itemDone.type, completed.type],
    )
    assert.deepEqual(events.at(-1).response.usage, completed.response.usage)
  })
}

for (const type of ['response.failed', 'response.incomplete', 'error']) {
  test(`real top-level ${type} remains a failure, never a forged completion`, { timeout: 10000 }, async (t) => {
    const terminal =
      type === 'error'
        ? { type, error: { code: 'fixture_error', message: 'fixture failure' } }
        : { type, response: { id: 'resp_fixture', status: type.slice(9), error: { code: 'fixture_error' } } }
    const events = await fixture(t, [created, terminal])
    assert.equal(events.at(-1).type, type)
    assert.ok(!events.some((event) => event.type === 'response.completed'))
  })
}
