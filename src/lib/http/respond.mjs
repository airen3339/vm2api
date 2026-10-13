/**
 * Shared HTTP helpers for protocol and panel. SSE headers flush immediately
 * and optionally disable Nagle so Claude Code subagent tokens are not delayed.
 */
import { ErrorCode, ErrorType, makeError } from '../core/errors.mjs'

export const CORS_ALLOW_HEADERS =
  'authorization, content-type, x-api-key, anthropic-version, anthropic-beta, x-session-id, x-kin-rewrite, x-panel-token, x-request-id, x-kin-debug, x-kin-log, x-kin-vm, x-kin-backend'

export function corsHeaders(extra = {}) {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': CORS_ALLOW_HEADERS,
    'access-control-allow-methods': 'GET,POST,OPTIONS,PUT,DELETE,PATCH',
    ...extra,
  }
}

function collectBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      req.removeAllListeners('data')
      req.on('data', () => {})
      req.resume()
      reject(error)
    }
    req.on('data', (c) => {
      if (settled) return
      size += c.length
      if (size > maxBytes) {
        fail(
          makeError({
            type: ErrorType.INVALID_REQUEST,
            code: ErrorCode.BODY_TOO_LARGE,
            message: `Request body exceeds limit of ${maxBytes} bytes`,
            status: 413,
            details: { max_bytes: maxBytes, received: size },
          }),
        )
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks))
    })
    req.on('error', (e) =>
      fail(
        makeError({
          type: ErrorType.API,
          code: 'request_stream_error',
          message: String(e.message || e),
          status: 400,
        }),
      ),
    )
  })
}

export function readBody(req, maxBytes) {
  return collectBody(req, maxBytes).then((buf) => {
    const raw = buf.toString('utf8')
    if (!raw) return {}
    try {
      return JSON.parse(raw)
    } catch (e) {
      throw makeError({
        type: ErrorType.INVALID_REQUEST,
        code: ErrorCode.INVALID_JSON,
        message: 'Request body is not valid JSON: ' + (e.message || 'parse error'),
        status: 400,
        details: { parse_error: String(e.message || e) },
      })
    }
  })
}

/**
 * Node 的 WHATWG URL 会拒绝未加括号的 IPv6、非 ASCII Host、空 Host。
 * 安装探活打的是 127.0.0.1，浏览器若用这类 Host 打开 /cc，旧代码在进路由前就 500。
 * Host 解析失败时仍用路径路由；路径本身非法才返回 null。
 */
export function parseRequestUrl(req) {
  const raw = req?.url || '/'
  const host = String(req?.headers?.host || '').trim()
  const bases = []
  if (host) bases.push(`http://${host}`)
  bases.push('http://127.0.0.1')
  for (const base of bases) {
    try {
      return new URL(raw, base)
    } catch {
      // try the next base
    }
  }
  return null
}

export function readRawBody(req, maxBytes) {
  return collectBody(req, maxBytes)
}

export function applySseSocketTuning(res, { tcpNodelay = true } = {}) {
  if (typeof res.flushHeaders === 'function') {
    try {
      res.flushHeaders()
    } catch {}
  }
  if (tcpNodelay !== false) {
    try {
      res.socket?.setNoDelay?.(true)
    } catch {}
  }
}

export function createRespond(cfg, options = {}) {
  const resolveNodelay = () => {
    if (typeof options.tcpNodelay === 'function') return options.tcpNodelay() !== false
    return options.tcpNodelay !== false
  }

  function json(res, status, body) {
    const data = JSON.stringify(body)
    const headers = corsHeaders({
      'content-type': 'application/json; charset=utf-8',
      'x-kin-rewrite': cfg.rewrite.enabled ? 'on' : 'off',
    })
    if (body?.error?.details?.retryable === false) headers['x-should-retry'] = 'false'
    if (res._kinRequestId) headers['x-request-id'] = res._kinRequestId
    res.writeHead(status, headers)
    res.end(data)
  }

  function writeSSEHeaders(res) {
    const headers = corsHeaders({
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-kin-rewrite': cfg.rewrite.enabled ? 'on' : 'off',
    })
    if (res._kinRequestId) headers['x-request-id'] = res._kinRequestId
    res.writeHead(200, headers)
    applySseSocketTuning(res, { tcpNodelay: resolveNodelay() })
  }

  return { json, writeSSEHeaders, readBody, readRawBody, corsHeaders }
}
