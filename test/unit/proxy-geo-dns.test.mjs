import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import http from 'node:http'
import { lookupProxyGeo, lookupProxyGeoV6 } from '../../src/lib/vm/proxy-geo.mjs'
import { createProxyAgent } from '../../src/lib/vm/proxy-agent.mjs'

for (const scheme of ['socks5', 'socks5h', 'http', 'https', '']) {
  test(`geo DNS policy: ${scheme || 'direct'}`, async () => {
    const url = scheme ? `${scheme}://127.0.0.1:1080` : ''
    const agents = []
    const fetchImpl = async (endpoint, opts) => {
      agents.push(opts?.agent)
      const acceptHdr = String(opts?.headers?.accept || '')
      if (acceptHdr.includes('text/plain') || String(endpoint).includes('icanhazip')) {
        return { ok: true, text: async () => '2001:db8::1' }
      }
      const query = String(endpoint).includes('2001') ? '2001:db8::1' : '203.0.113.1'
      return {
        ok: true,
        json: async () => ({ status: 'success', query, timezone: 'Asia/Tokyo' }),
      }
    }
    assert.equal((await lookupProxyGeo(url, { fetchImpl })).ok, true)
    assert.equal((await lookupProxyGeoV6(url, { fetchImpl })).ok, true)
    assert.equal(agents.length, 3)
    for (const agent of agents) {
      if (scheme.startsWith('socks')) assert.equal(agent.shouldLookup, false)
      else if (scheme) assert.equal(agent.constructor.name, 'HttpsProxyAgent')
      else assert.equal(agent, undefined)
    }
    // Only geo opts into remote DNS; explicit SOCKS5 elsewhere retains its semantics.
    if (scheme === 'socks5') assert.equal(createProxyAgent(url).shouldLookup, true)
  })
}

test('geo succeeds through loopback SOCKS5 when local destination DNS is unavailable', async (t) => {
  const sockets = new Set()
  const requestedHosts = []
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    let stage = 'greeting'
    let pending = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk])
      if (stage === 'greeting') {
        if (pending.length < 2 || pending.length < 2 + pending[1]) return
        pending = pending.subarray(2 + pending[1])
        socket.write(Buffer.from([5, 0]))
        stage = 'connect'
      }
      if (stage === 'connect') {
        if (pending.length < 5) return
        if (pending[3] !== 3) return socket.destroy()
        const length = pending[4]
        if (pending.length < 7 + length) return
        requestedHosts.push(pending.subarray(5, 5 + length).toString())
        pending = pending.subarray(7 + length)
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]))
        stage = 'http'
      }
      if (stage === 'http' && pending.includes('\r\n\r\n')) {
        stage = 'done'
        const body = JSON.stringify({ status: 'success', query: '203.0.113.1', timezone: 'Asia/Tokyo' })
        socket.end(
          `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
        )
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
  })
  let localDnsCalls = 0
  const fetchImpl = (url, options) =>
    new Promise((resolve, reject) => {
      const req = http.get(
        url,
        {
          agent: options.agent,
          signal: options.signal,
          lookup: (_host, _opts, callback) => {
            localDnsCalls += 1
            callback(Object.assign(new Error('local DNS unavailable'), { code: 'ENOTFOUND' }))
          },
        },
        (res) => {
          let body = ''
          res.on('data', (chunk) => {
            body += chunk
          })
          res.on('end', () => resolve({ ok: res.statusCode === 200, json: async () => JSON.parse(body) }))
          res.on('error', reject)
        },
      )
      req.on('error', reject)
    })
  const result = await lookupProxyGeo(`socks5://127.0.0.1:${server.address().port}`, {
    endpoint: 'http://geo.invalid/json',
    fetchImpl,
    timeoutMs: 1500,
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.geo.timezone, 'Asia/Tokyo')
  assert.equal(localDnsCalls, 0)
  assert.deepEqual(requestedHosts, ['geo.invalid'])
})
