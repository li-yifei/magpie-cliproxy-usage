import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const management = '/v0/management/'
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const CODEX_CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits'
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const ANTIGRAVITY_SUMMARY_URL = 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary'
const ANTIGRAVITY_MODELS_URL = 'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels'
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo'
const GROK_USAGE_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits'

const windowDurations = new Map([['5 hours', 18000], ['7 days', 604800]])
const keyFileName = 'cliproxy-usage-management.key'
const legacyKeyFileName = 't3-usage-management.key'

function clampPercent(value) {
  return Math.max(0, Math.min(100, value))
}

function numericWindows(card) {
  return (card.windows ?? []).filter(w => !w.text && !w.unlimited && Number.isFinite(w.used))
}

function isRemoteCard(card) {
  return Boolean(card.from) || String(card.provider ?? '').includes('/')
}

function baseProviderName(providerId) {
  const raw = String(providerId ?? '').trim().toLowerCase()
  const leaf = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw
  return leaf.replace(/-plugin$/, '')
}

function cliProxyProviderOf(providerId) {
  switch (baseProviderName(providerId)) {
    case 'codex':
      return 'codex'
    case 'claude':
      return 'claude'
    case 'antigravity':
    case 'agy-cli':
      return 'antigravity'
    case 'grok':
    case 'xai':
      return 'xai'
    default:
      return null
  }
}

function normalizeFilterList(value) {
  if (!Array.isArray(value)) return []
  return value.map(v => String(v ?? '').trim().toLowerCase()).filter(Boolean)
}

function matchesFilter(card, mappedProvider, list) {
  const id = String(card.provider ?? '').trim().toLowerCase()
  const base = baseProviderName(id)
  const mapped = String(mappedProvider ?? '').toLowerCase()
  return list.includes(id) || list.includes(base) || (mapped !== '' && list.includes(mapped))
}

function accountIdFor(providerId) {
  if (providerId === 'codex') return 'native-codex'
  return 'magpie-' + String(providerId).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function accountLabelFor(cards, providerId) {
  if (cards.length === 1) {
    const c = cards[0]
    if (c.user && c.name) return `${c.name} (${c.user})`
    return c.user || c.name || providerId
  }
  const name = cards[0]?.name || providerId
  return `${name} (${cards.length} accounts)`
}

function averageWindow(cards, predicate) {
  const readings = cards.flatMap(card => numericWindows(card).filter(predicate))
  if (readings.length === 0) return null
  const used = readings.reduce((sum, w) => sum + clampPercent(w.used), 0) / readings.length
  const firstReset = Date.parse(readings[0].resetsAt)
  const sameReset = Number.isFinite(firstReset) &&
    readings.length === cards.length &&
    readings.every(w => Date.parse(w.resetsAt) === firstReset)
  return {
    used,
    resetMs: sameReset ? firstReset : null,
    resetIso: sameReset ? new Date(firstReset).toISOString() : null,
  }
}

function buildCodexUsage(cards) {
  const primary = averageWindow(cards, w => windowDurations.get(w.name) === 18000)
  const secondary = averageWindow(cards, w => windowDurations.get(w.name) === 604800)
  if (!primary && !secondary) return null
  const format = (w, secs) => w ? {
    used_percent: w.used,
    reset_at: w.resetMs === null ? null : Math.floor(w.resetMs / 1000),
    limit_window_seconds: secs,
  } : null
  const plan = cards.find(c => c.plan)?.plan
  return {
    ...(plan ? { plan_type: plan } : {}),
    rate_limit: {
      primary_window: format(primary, 18000),
      secondary_window: format(secondary, 604800),
    },
  }
}

function buildCodexCredits(cards) {
  if (cards.length !== 1) return null
  const each = cards[0]?.resets?.each
  if (!Array.isArray(each) || each.length === 0) return null
  return {
    credits: each.filter(c => c?.id && c?.until).map(c => ({
      id: String(c.id),
      status: 'available',
      reset_type: 'rate_limit',
      expires_at: String(c.until),
    })),
  }
}

function buildClaudeUsage(cards) {
  const fiveHour = averageWindow(cards, w => w.name === '5 hours')
  const sevenDay = averageWindow(cards, w => w.name === '7 days')
  const scopedNames = [...new Set(
    cards.flatMap(c => numericWindows(c))
      .map(w => /^7 days\s*[·-]\s*(.+)$/i.exec(w.name)?.[1]?.trim())
      .filter(Boolean),
  )]
  const limits = []
  for (const modelName of scopedNames) {
    const avg = averageWindow(cards, w => {
      const m = /^7 days\s*[·-]\s*(.+)$/i.exec(w.name)?.[1]?.trim()
      return m === modelName
    })
    if (avg) {
      limits.push({
        kind: 'weekly_scoped',
        percent: avg.used,
        resets_at: avg.resetIso,
        scope: { model: { display_name: modelName } },
      })
    }
  }
  if (!fiveHour && !sevenDay && limits.length === 0) return null
  return {
    five_hour: fiveHour ? { utilization: fiveHour.used, resets_at: fiveHour.resetIso } : null,
    seven_day: sevenDay ? { utilization: sevenDay.used, resets_at: sevenDay.resetIso } : null,
    ...(limits.length > 0 ? { limits } : {}),
  }
}

function antigravityBucketPrefix(pool) {
  const p = String(pool ?? '').toLowerCase()
  if (p.includes('gemini')) return 'gemini'
  if (p.includes('claude') || p.includes('gpt')) return '3p'
  return p.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'pool'
}

function buildAntigravitySummary(cards) {
  const pools = [...new Set(
    cards.flatMap(c => numericWindows(c))
      .filter(w => w.pool && (w.name === '5 hours' || w.name === '7 days'))
      .map(w => w.pool),
  )]
  const groups = []
  for (const pool of pools) {
    const prefix = antigravityBucketPrefix(pool)
    const buckets = []
    for (const [winName, winKind] of [['5 hours', '5h'], ['7 days', 'weekly']]) {
      const avg = averageWindow(cards, w => w.pool === pool && w.name === winName)
      if (!avg) continue
      buckets.push({
        bucketId: `${prefix}-${winKind}`,
        displayName: pool,
        window: winKind,
        remainingFraction: Math.max(0, Math.min(1, 1 - avg.used / 100)),
        ...(avg.resetIso ? { resetTime: avg.resetIso } : {}),
      })
    }
    if (buckets.length > 0) {
      groups.push({ displayName: pool, buckets })
    }
  }
  if (groups.length === 0) return null
  return { groups }
}

function buildGrokUsage(cards) {
  const avg = averageWindow(cards, () => true)
  if (!avg) return null
  return {
    config: {
      creditUsagePercent: avg.used,
      currentPeriod: avg.resetIso ? { end: avg.resetIso } : {},
    },
  }
}

function buildEntry(providerId, mappedProvider, cards) {
  let payload = null
  if (mappedProvider === 'codex') payload = buildCodexUsage(cards)
  else if (mappedProvider === 'claude') payload = buildClaudeUsage(cards)
  else if (mappedProvider === 'antigravity') payload = buildAntigravitySummary(cards)
  else if (mappedProvider === 'xai') payload = buildGrokUsage(cards)
  if (!payload) return null

  const id = accountIdFor(providerId)
  const plan = cards.find(c => c.plan)?.plan
  const file = {
    id,
    auth_index: id,
    provider: mappedProvider,
    email: accountLabelFor(cards, providerId),
    ...(mappedProvider === 'antigravity' ? { project_id: 'magpie' } : {}),
    ...(mappedProvider === 'codex' && plan ? { id_token: { plan_type: plan } } : {}),
  }
  return {
    id,
    magpieProvider: providerId,
    mappedProvider,
    file,
    payload,
    credits: mappedProvider === 'codex' ? buildCodexCredits(cards) : null,
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

function createUsageServer({ loadCards, managementKey, options = {} }) {
  if (!managementKey) throw new Error('Missing management key')
  const includeProviders = normalizeFilterList(options.includeProviders)
  const excludeProviders = normalizeFilterList(options.excludeProviders)
  const includeRemote = Boolean(options.includeRemote)

  let cached
  let pending
  async function snapshot() {
    if (cached && Date.now() < cached.expires) return cached.value
    pending ??= Promise.resolve().then(loadCards).then(cards => {
      const grouped = new Map()
      const discovered = new Map()

      for (const card of cards) {
        if (!card?.provider) continue
        const providerId = String(card.provider)
        const remote = isRemoteCard(card)
        const mapped = cliProxyProviderOf(providerId)
        const hasQuota = numericWindows(card).length > 0
        const explicitlyIncluded = includeProviders.length > 0 && matchesFilter(card, mapped, includeProviders)
        const excluded = excludeProviders.length > 0 && matchesFilter(card, mapped, excludeProviders)
        const enabled = Boolean(
          mapped &&
          hasQuota &&
          !excluded &&
          (includeProviders.length === 0 || explicitlyIncluded) &&
          (!remote || includeRemote || explicitlyIncluded),
        )

        if (!discovered.has(providerId)) {
          discovered.set(providerId, {
            provider: providerId,
            name: card.name || providerId,
            cliProxyProvider: mapped,
            remote,
            hasQuota,
            enabled,
            accounts: 0,
          })
        }
        discovered.get(providerId).accounts += 1

        if (enabled) {
          if (!grouped.has(providerId)) grouped.set(providerId, { mapped, cards: [] })
          grouped.get(providerId).cards.push(card)
        }
      }

      const entries = new Map()
      for (const [providerId, { mapped, cards: groupCards }] of grouped) {
        const entry = buildEntry(providerId, mapped, groupCards)
        if (entry) entries.set(entry.id, entry)
      }

      const value = { entries, discovered: [...discovered.values()] }
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
        const { entries } = await snapshot()
        return json(res, 200, { files: [...entries.values()].map(e => e.file) })
      }
      if (req.method === 'GET' && path.pathname === management + 'providers') {
        const { discovered } = await snapshot()
        return json(res, 200, { providers: discovered })
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
      const { entries } = await snapshot()
      const entry = entries.get(call?.auth_index)
      if (!entry) return json(res, 404, { error: 'Unknown account' })

      if (entry.mappedProvider === 'codex') {
        if (call.method === 'GET' && call.url === CODEX_USAGE_URL) {
          return json(res, 200, { status_code: 200, body: JSON.stringify(entry.payload) })
        }
        if (call.method === 'GET' && call.url === CODEX_CREDITS_URL) {
          if (!entry.credits) return json(res, 501, { error: 'Reset credit lookup is unavailable' })
          return json(res, 200, { status_code: 200, body: JSON.stringify(entry.credits) })
        }
        return json(res, 405, { error: 'Unsupported operation' })
      }

      if (entry.mappedProvider === 'claude') {
        if (call.method === 'GET' && String(call.url ?? '').startsWith(CLAUDE_USAGE_URL)) {
          return json(res, 200, { status_code: 200, body: JSON.stringify(entry.payload) })
        }
        return json(res, 405, { error: 'Unsupported operation' })
      }

      if (entry.mappedProvider === 'antigravity') {
        if (call.method === 'POST' && call.url === ANTIGRAVITY_SUMMARY_URL) {
          return json(res, 200, { status_code: 200, body: JSON.stringify(entry.payload) })
        }
        if (call.method === 'GET' && call.url === GOOGLE_USERINFO_URL) {
          return json(res, 200, { status_code: 404, body: JSON.stringify({ error: 'Unavailable' }) })
        }
        if (call.method === 'POST' && call.url === ANTIGRAVITY_MODELS_URL) {
          return json(res, 501, { error: 'Per-model Antigravity lookup is unavailable' })
        }
        return json(res, 405, { error: 'Unsupported operation' })
      }

      if (entry.mappedProvider === 'xai') {
        if (call.method === 'GET' && call.url === GROK_USAGE_URL) {
          return json(res, 200, { status_code: 200, body: JSON.stringify(entry.payload) })
        }
        return json(res, 405, { error: 'Unsupported operation' })
      }

      return json(res, 405, { error: 'Unsupported operation' })
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

function resolvePort(options) {
  const raw = options?.port ?? process.env.MAGPIE_CLIPROXY_USAGE_PORT ?? process.env.MAGPIE_T3_USAGE_PORT ?? 3426
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${raw}`)
  }
  return port
}

async function isAlreadyServing(host, port, managementKey) {
  try {
    const probeHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
    const res = await fetch(`http://${probeHost}:${port}${management}auth-files`, {
      headers: { Authorization: 'Bearer ' + managementKey },
      redirect: 'error',
      signal: AbortSignal.timeout(1500),
    })
    return res.status === 200
  } catch {
    return false
  }
}

async function listenWithRetry(server, port, host, managementKey, retries = 8, delayMs = 250) {
  for (let attempt = 0; ; attempt++) {
    try {
      await new Promise((resolveListen, rejectListen) => {
        const onError = err => {
          server.off('listening', onListening)
          rejectListen(err)
        }
        const onListening = () => {
          server.off('error', onError)
          resolveListen()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(port, host)
      })
      return true
    } catch (err) {
      if (err?.code !== 'EADDRINUSE') throw err
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, delayMs))
        continue
      }
      if (await isAlreadyServing(host, port, managementKey)) return false
      throw err
    }
  }
}

let listener
async function start(options = {}) {
  if (listener) return listener
  const configDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'magpie')
  const managementKey = await resolveManagementKey(configDir, options)
  const port = resolvePort(options)
  const host = String(options?.host ?? process.env.MAGPIE_CLIPROXY_USAGE_HOST ?? '127.0.0.1')

  const server = createUsageServer({
    managementKey,
    options,
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

  const bound = await listenWithRetry(server, port, host, managementKey)
  if (!bound) return null
  listener = server
  return server
}

export async function MagpieCliProxyUsagePlugin(_input, options) {
  const server = await start(options)
  server?.unref()
  return {}
}

export default {
  id: 'magpie-cliproxy-usage',
  server: MagpieCliProxyUsagePlugin,
}

export { createUsageServer, resolveManagementKey, resolvePort }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await start()
}
