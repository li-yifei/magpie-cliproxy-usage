import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const management = '/v0/management/'
const wham = 'https://chatgpt.com/backend-api/wham/'
const windows = new Map([['5 hours', 18000], ['7 days', 604800]])
const accountId = 'native-codex'

const keyFileName = 'cliproxy-usage-management.key'
const legacyKeyFileName = 't3-usage-management.key'

function quotaWindow(cards, duration) {
  const readings = cards.flatMap(card => (card.windows ?? []).filter(window =>
    windows.get(window.name) === duration && !window.text && !window.unlimited &&
    Number.isFinite(window.used)))
  if (readings.length === 0) return null
  const used = readings.reduce((sum, window) =>
    sum + Math.max(0, Math.min(100, window.used)), 0)
  const reset = Date.parse(readings[0].resetsAt)
  return {
    used_percent: used / readings.length,
    reset_at: Number.isFinite(reset) && readings.length === cards.length &&
      readings.every(window => Date.parse(window.resetsAt) === reset)
      ? Math.floor(reset / 1000) : null,
    limit_window_seconds: duration,
  }
}

function authorized(header, managementKey) {
  if (typeof header !== 'string') return false
  const expected = Buffer.from('Bearer ' + managementKey, 'utf8')
  const actual = Buffer.from(header, 'utf8')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

function createUsageServer({ loadCards, managementKey }) {
  if (!managementKey) throw new Error('Missing management key')
  let cached
  let pending
  async function quotas() {
    if (cached && Date.now() < cached.expires) return cached.value
    pending ??= Promise.resolve().then(loadCards).then(cards => {
      const native = cards.filter(card => card.provider === 'codex' && card.kind === 'subscription')
      const primary = quotaWindow(native, 18000)
      const secondary = quotaWindow(native, 604800)
      const value = primary || secondary ? { primary_window: primary, secondary_window: secondary } : null
      cached = { value, expires: Date.now() + 15000 }
      return value
    }).finally(() => { pending = undefined })
    return pending
  }

  return createServer(async (req, res) => {
    if (!authorized(req.headers.authorization, managementKey)) {
      return json(res, 401, { error: 'Unauthorized' })
    }
    try {
      const path = new URL(req.url, 'http://localhost')
      if (req.method === 'GET' && path.pathname === management + 'auth-files') {
        const files = await quotas()
          ? [{ id: accountId, auth_index: accountId, provider: 'codex', email: 'Native Codex' }]
          : []
        return json(res, 200, { files })
      }
      if (req.method === 'GET' && path.pathname === management + 'auth-files/models') {
        return json(res, 501, { error: 'Per-account model routing is unavailable' })
      }
      if (req.method !== 'POST' || path.pathname !== management + 'api-call') {
        return json(res, 404, { error: 'Unknown route' })
      }
      let body = ''
      for await (const chunk of req) {
        body += chunk
        if (body.length > 16384) return json(res, 413, { error: 'Request too large' })
      }
      let call
      try { call = JSON.parse(body) } catch {
        return json(res, 400, { error: 'Invalid JSON' })
      }
      if (call?.method !== 'GET' || ![wham + 'usage', wham + 'rate-limit-reset-credits'].includes(call.url)) {
        return json(res, 405, { error: 'Unsupported operation' })
      }
      if (call.auth_index !== accountId) return json(res, 404, { error: 'Unknown account' })
      if (call.url !== wham + 'usage') {
        return json(res, 501, { error: 'Reset credit lookup is unavailable' })
      }
      const result = { rate_limit: await quotas() }
      return json(res, 200, { status_code: 200, body: JSON.stringify(result) })
    } catch {
      return json(res, 502, { error: 'Could not read local Magpie quota cards' })
    }
  })
}

async function resolveManagementKey(configDir, options) {
  const fromOpt = typeof options?.managementKey === 'string' ? options.managementKey.trim() : ''
  if (fromOpt) return fromOpt

  const fromEnv = (process.env.MAGPIE_CLIPROXY_MANAGEMENT_KEY || process.env.MAGPIE_T3_MANAGEMENT_KEY || '').trim()
  if (fromEnv) return fromEnv

  const keyPath = join(configDir, keyFileName)
  for (const candidate of [keyPath, join(configDir, legacyKeyFileName)]) {
    try {
      const value = (await readFile(candidate, 'utf8')).trim()
      if (value) return value
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err
    }
  }

  await mkdir(configDir, { recursive: true })
  const generated = randomBytes(24).toString('base64url')
  await writeFile(keyPath, generated + '\n', { mode: 0o600, flag: 'wx' }).catch(async err => {
    if (err?.code !== 'EEXIST') throw err
  })
  return (await readFile(keyPath, 'utf8')).trim()
}

let listener
async function start(options = {}) {
  if (listener) return listener
  const configDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'magpie')
  const managementKey = await resolveManagementKey(configDir, options)
  const port = Number(
    options?.port ??
    process.env.MAGPIE_CLIPROXY_USAGE_PORT ??
    process.env.MAGPIE_T3_USAGE_PORT ??
    3426,
  )
  const host = String(
    options?.host ??
    process.env.MAGPIE_CLIPROXY_USAGE_HOST ??
    '127.0.0.1',
  )

  const server = createUsageServer({
    managementKey,
    loadCards: async () => {
      const { addr } = JSON.parse(await readFile(join(configDir, 'gateway.json'), 'utf8'))
      const gwPort = /:(\d+)$/.exec(addr)?.[1]
      if (!gwPort) throw new Error('Missing local Magpie gateway port')
      const response = await fetch('http://127.0.0.1:' + gwPort + '/v1/magpie/quotas/cards', {
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
      })
      if (!response.ok) throw new Error('Local Magpie returned HTTP ' + response.status)
      const { data } = await response.json()
      if (!Array.isArray(data)) throw new Error('Invalid Magpie quota response')
      return data
    },
  })

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(port, host, resolveListen)
  })
  listener = server
  return server
}

export async function MagpieCliProxyUsagePlugin(_input, options) {
  const server = await start(options)
  server.unref()
  return {}
}

export default {
  id: 'magpie-cliproxy-usage',
  server: MagpieCliProxyUsagePlugin,
}

export { createUsageServer, resolveManagementKey }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await start()
}
