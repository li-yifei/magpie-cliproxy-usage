import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { link, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { isIP } from 'node:net'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const management = '/v0/management/'
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const CODEX_CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits'
const CLAUDE_USAGE_URL = new URL('https://api.anthropic.com/api/oauth/usage')
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo'
const GROK_USAGE_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits'
const maxBodyBytes = 16 * 1024

const grokPeriods = new Map([
  ['1 day', 'DAILY'], ['daily', 'DAILY'],
  ['7 days', 'WEEKLY'], ['weekly', 'WEEKLY'],
  ['month', 'MONTHLY'], ['monthly', 'MONTHLY'],
  ['allowance', null],
])
const keyFileName = 'cliproxy-usage-management.key'
const legacyKeyFileName = 't3-usage-management.key'

function clampPercent(value) {
  return Math.max(0, Math.min(100, value))
}

function numericWindows(card) {
  if (!Array.isArray(card.windows)) return []
  return card.windows.filter(w => w && typeof w === 'object' &&
    typeof w.name === 'string' && w.name.trim() &&
    !w.text && !w.unlimited && Number.isFinite(w.used))
}

function isRemoteCard(card) {
  return Boolean(card.from) || card.provider.includes('/')
}

function baseProviderName(id) {
  const leaf = id.slice(id.lastIndexOf('/') + 1)
  return leaf.replace(/-plugin$/, '')
}

function cliProxyProviderOf(base) {
  switch (base) {
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

function normalizeFilterList(value, name) {
  if (value === undefined) return []
  if (!Array.isArray(value) || [...value].some(item => typeof item !== 'string')) {
    throw new Error(`${name} must be an array of strings`)
  }
  return value.map(item => item.trim().toLowerCase()).filter(Boolean)
}

function readBoolean(value, name) {
  if (value === undefined) return false
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`)
  return value
}

function providerOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('Plugin options must be an object')
  }
  return {
    includeProviders: normalizeFilterList(options.includeProviders, 'includeProviders'),
    excludeProviders: normalizeFilterList(options.excludeProviders, 'excludeProviders'),
    includeRemote: readBoolean(options.includeRemote, 'includeRemote'),
  }
}

function matchesFilter(list, id, base, mapped) {
  return list.includes(id) || list.includes(base) || list.includes(mapped)
}

function accountIdFor(providerId) {
  if (providerId === 'codex') return 'native-codex'
  if (/^[a-z0-9][a-z0-9-]*$/.test(providerId)) return 'magpie-' + providerId
  return 'magpie-id.' + Buffer.from(providerId, 'utf16le').toString('base64url')
}

function accountLabelFor(cards, providerId) {
  if (cards.length === 1) {
    const c = cards[0]
    const user = typeof c.user === 'string' ? c.user : ''
    const name = typeof c.name === 'string' ? c.name : ''
    if (user && name) return `${name} (${user})`
    return user || name || providerId
  }
  const name = cards.find(c => typeof c.name === 'string' && c.name)?.name || providerId
  return `${name} (${cards.length} accounts)`
}

function averageWindow(cards, predicate, fallbackTime) {
  const readings = cards.map(card => card.windows.find(predicate)).filter(Boolean)
  if (readings.length === 0) return null
  const used = readings.reduce((sum, w) => sum + clampPercent(w.used), 0) / readings.length
  const resets = readings.map(w => {
    const at = typeof w.resetsAt === 'string' ? Date.parse(w.resetsAt) : NaN
    if (Number.isFinite(at)) return at
    if (fallbackTime !== undefined && Number.isSafeInteger(w.resetSecs) && w.resetSecs >= 0) {
      return new Date(fallbackTime + w.resetSecs * 1000).getTime()
    }
    return NaN
  })
  const firstReset = resets[0]
  const sameReset = Number.isFinite(firstReset) && resets.every(at => at === firstReset)
  return {
    used,
    readings,
    resetMs: sameReset ? firstReset : null,
    resetIso: sameReset ? new Date(firstReset).toISOString() : null,
  }
}

function buildCodexUsage(cards) {
  const now = Math.floor(Date.now() / 1000) * 1000
  const primary = averageWindow(cards, w => w.name === '5 hours', now)
  const secondary = averageWindow(cards, w => w.name === '7 days', now)
  if (!primary && !secondary) return null
  const format = (w, secs) => w ? {
    used_percent: w.used,
    reset_at: w.resetMs === null ? null : Math.floor(w.resetMs / 1000),
    limit_window_seconds: secs,
  } : null
  const plan = cards.find(c => typeof c.plan === 'string' && c.plan)?.plan
  return {
    ...(plan ? { plan_type: plan } : {}),
    rate_limit: {
      primary_window: format(primary, 18000),
      secondary_window: format(secondary, 604800),
    },
  }
}

function codexUsageAtPoll(payload) {
  const now = Math.floor(Date.now() / 1000)
  const withCountdown = window => window && {
    ...window,
    reset_after_seconds: window.reset_at === null ? null : Math.max(0, window.reset_at - now),
  }
  return {
    ...payload,
    rate_limit: {
      primary_window: withCountdown(payload.rate_limit.primary_window),
      secondary_window: withCountdown(payload.rate_limit.secondary_window),
    },
  }
}

function buildClaudeUsage(cards) {
  const fiveHour = averageWindow(cards, w => w.name === '5 hours')
  const sevenDay = averageWindow(cards, w => w.name === '7 days')
  const scopedNames = [...new Set(
    cards.flatMap(c => c.windows)
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
  const slug = pool.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  if (slug === 'claude-gpt' || slug === 'claude-and-gpt' || slug === '3p') return '3p'
  return slug.replace(/^gemini-(?:\d+-)+(?=(?:argon|carbon)(?:-|$))/, 'gemini-') || 'pool'
}

function antigravityModelId(window) {
  for (const id of [window.model, window.modelId]) {
    if (typeof id === 'string' && id.trim()) return id.trim()
  }
  if (typeof window.family === 'string' && window.family.trim()) {
    // Magpie's quota JSON keeps the family and display name, but may omit the model ID.
    return window.name.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, '')
  }
  if (/^(gemini|claude|gpt)-[a-z0-9][a-z0-9.-]*$/i.test(window.name)) return window.name.toLowerCase()
  return ''
}

function buildAntigravitySummary(cards) {
  const pools = [...new Set(
    cards.flatMap(c => c.windows)
      .filter(w => typeof w.pool === 'string' && w.pool.trim() &&
        !antigravityModelId(w) && (w.name === '5 hours' || w.name === '7 days'))
      .map(w => w.pool),
  )]
  const groups = []
  for (const pool of pools) {
    const base = antigravityBucketPrefix(pool)
    const prefix = pools.some(other => other !== pool && antigravityBucketPrefix(other) === base)
      ? `${base}.${Buffer.from(pool, 'utf16le').toString('base64url')}`
      : base
    const buckets = []
    for (const [winName, winKind] of [['5 hours', '5h'], ['7 days', 'weekly']]) {
      const avg = averageWindow(cards, w => w.pool === pool && w.name === winName && !antigravityModelId(w))
      if (!avg) continue
      buckets.push({
        bucketId: `${prefix}-${winKind}`,
        displayName: pool,
        window: winKind,
        remainingFraction: 1 - avg.used / 100,
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

function buildAntigravityModels(cards) {
  const readings = cards.flatMap(card => card.windows)
  const modelIds = new Set(readings.map(antigravityModelId).filter(Boolean))
  if (modelIds.size === 0) return null
  return {
    models: Object.fromEntries([...modelIds].map(id => {
      const avg = averageWindow(cards, w => antigravityModelId(w) === id)
      return [id, {
        displayName: avg.readings[0].name,
        quotaInfo: {
          remainingFraction: 1 - avg.used / 100,
          ...(avg.resetIso ? { resetTime: avg.resetIso } : {}),
        },
      }]
    })),
  }
}

function grokPeriod(window) {
  return grokPeriods.get(window.name.trim().toLowerCase())
}

function buildGrokUsage(cards) {
  const avg = averageWindow(cards, w => grokPeriod(w) !== undefined)
  if (!avg) return null
  const period = grokPeriod(avg.readings[0])
  const samePeriod = period && avg.readings.every(w => grokPeriod(w) === period)
  return {
    config: {
      creditUsagePercent: avg.used,
      currentPeriod: {
        ...(samePeriod ? { type: 'USAGE_PERIOD_TYPE_' + period } : {}),
        ...(avg.resetIso ? { end: avg.resetIso } : {}),
      },
    },
  }
}

function buildEntry(providerId, mappedProvider, cards) {
  let payload = null
  let models = null
  if (mappedProvider === 'codex') payload = buildCodexUsage(cards)
  else if (mappedProvider === 'claude') payload = buildClaudeUsage(cards)
  else if (mappedProvider === 'antigravity') {
    payload = buildAntigravitySummary(cards)
    models = buildAntigravityModels(cards)
  } else if (mappedProvider === 'xai') payload = buildGrokUsage(cards)
  if (!payload && !models) return null

  const id = accountIdFor(providerId)
  const plan = payload?.plan_type
  const file = {
    id,
    name: id,
    type: mappedProvider,
    status: 'active',
    disabled: false,
    auth_index: id,
    provider: mappedProvider,
    email: accountLabelFor(cards, providerId),
    ...(mappedProvider === 'antigravity' ? { project_id: 'magpie' } : {}),
    ...(mappedProvider === 'codex' && plan ? { id_token: { plan_type: plan } } : {}),
  }
  return {
    id,
    mappedProvider,
    file,
    payload,
    models,
  }
}

function keyDigest(key) {
  return createHash('sha256').update(key).digest()
}

function authorized(headers, expected) {
  const bearer = /^Bearer +([^ ]+)$/i.exec(headers.authorization ?? '')?.[1]
  const matches = key => typeof key === 'string' && timingSafeEqual(keyDigest(key), expected)
  return matches(bearer) || matches(headers['x-management-key'])
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

function apiCallResult(res, body, statusCode = 200) {
  return json(res, 200, { status_code: statusCode, header: {}, body: JSON.stringify(body) })
}

function parseUrl(value, base) {
  if (typeof value !== 'string') return null
  try {
    return new URL(value, base)
  } catch {
    return null
  }
}

function handleApiCall(res, entry, call) {
  const method = typeof call.method === 'string' ? call.method.trim().toUpperCase() : ''
  const url = parseUrl(call.url)
  const href = url?.href

  if (entry.mappedProvider === 'codex' && method === 'GET') {
    if (href === CODEX_USAGE_URL) return apiCallResult(res, codexUsageAtPoll(entry.payload))
    if (href === CODEX_CREDITS_URL) {
      return json(res, 501, { error: 'Reset credit lookup is unavailable' })
    }
  }

  if (entry.mappedProvider === 'claude' && method === 'GET' &&
      url?.origin === CLAUDE_USAGE_URL.origin && url.pathname === CLAUDE_USAGE_URL.pathname) {
    return apiCallResult(res, entry.payload)
  }

  if (entry.mappedProvider === 'antigravity') {
    if (method === 'GET' && href === GOOGLE_USERINFO_URL) {
      return apiCallResult(res, { error: 'Unavailable' }, 404)
    }
    if (method === 'POST' && (url?.protocol === 'https:' || url?.protocol === 'http:')) {
      if (url.pathname.endsWith(':retrieveUserQuotaSummary')) {
        if (entry.payload) return apiCallResult(res, entry.payload)
        return json(res, 501, { error: 'Antigravity quota summary is unavailable' })
      }
      if (url.pathname.endsWith(':fetchAvailableModels')) {
        if (entry.models) return apiCallResult(res, entry.models)
        return json(res, 501, { error: 'Per-model Antigravity lookup is unavailable' })
      }
    }
  }

  if (entry.mappedProvider === 'xai' && method === 'GET' && href === GROK_USAGE_URL) {
    return apiCallResult(res, entry.payload)
  }
  return json(res, 405, { error: 'Unsupported operation' })
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > maxBodyBytes) return null
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

function createUsageServer({ loadCards, managementKey, options = {} }) {
  const expectedKey = keyDigest(validateManagementKey(managementKey))
  const { includeProviders, excludeProviders, includeRemote } = providerOptions(options)

  let cached
  let pending
  async function snapshot() {
    if (cached && Date.now() < cached.expires) return cached.value
    pending ??= Promise.resolve().then(loadCards).then(cards => {
      if (!Array.isArray(cards)) throw new Error('Invalid Magpie quota response')
      const grouped = new Map()
      const discovered = new Map()

      for (const card of cards) {
        if (typeof card?.provider !== 'string' || !card.provider.trim()) continue
        const providerId = card.provider
        const normalized = providerId.trim().toLowerCase()
        const base = baseProviderName(normalized)
        const remote = isRemoteCard(card)
        const mapped = cliProxyProviderOf(base)
        const windows = numericWindows(card)

        if (!discovered.has(providerId)) {
          discovered.set(providerId, {
            provider: providerId,
            name: typeof card.name === 'string' && card.name ? card.name : providerId,
            cliProxyProvider: mapped,
            remote,
            hasQuota: false,
            enabled: false,
            accounts: 0,
          })
        }
        const discovery = discovered.get(providerId)
        discovery.accounts += 1
        discovery.hasQuota ||= windows.length > 0
        discovery.remote ||= remote

        if (mapped && windows.length > 0 &&
            !matchesFilter(excludeProviders, normalized, base, mapped) &&
            (includeProviders.length === 0 || matchesFilter(includeProviders, normalized, base, mapped)) &&
            (!remote || includeRemote || includeProviders.includes(normalized))) {
          if (!grouped.has(providerId)) grouped.set(providerId, { mapped, cards: [] })
          grouped.get(providerId).cards.push({ name: card.name, user: card.user, plan: card.plan, windows })
        }
      }

      const entries = new Map()
      for (const [providerId, { mapped, cards: groupCards }] of grouped) {
        const entry = buildEntry(providerId, mapped, groupCards)
        if (entry) {
          entries.set(entry.id, entry)
          discovered.get(providerId).enabled = true
        }
      }

      const value = { entries, discovered: [...discovered.values()] }
      cached = { value, expires: Date.now() + 15000 }
      return value
    }).catch(() => {
      console.error('magpie-cliproxy-usage: failed to load quota cards from the local Magpie gateway.')
      cached = { value: null, expires: Date.now() + 3000 }
      return null
    }).finally(() => { pending = undefined })
    return pending
  }

  return createServer(async (req, res) => {
    if (!authorized(req.headers, expectedKey)) {
      return json(res, 401, { error: 'Unauthorized' })
    }
    try {
      const path = parseUrl(req.url, 'http://localhost')?.pathname
      if (req.method === 'GET' && path === management + 'auth-files/models') {
        return json(res, 501, { error: 'Per-account model routing is unavailable' })
      }
      const files = req.method === 'GET' && path === management + 'auth-files'
      const providers = req.method === 'GET' && path === management + 'providers'
      const apiCall = req.method === 'POST' && path === management + 'api-call'
      if (!(files || providers || apiCall)) {
        return json(res, 404, { error: 'Unknown route' })
      }
      let call
      if (apiCall) {
        const body = await readBody(req)
        if (body === null) {
          res.setHeader('Connection', 'close')
          return json(res, 413, { error: 'Request too large' })
        }
        try { call = JSON.parse(body) } catch {
          return json(res, 400, { error: 'Invalid JSON' })
        }
      }

      const quota = await snapshot()
      if (!quota) return json(res, 502, { error: 'Could not read local Magpie quota cards' })
      if (files) return json(res, 200, { files: [...quota.entries.values()].map(e => e.file) })
      if (providers) return json(res, 200, { providers: quota.discovered })

      const authIndex = [call?.auth_index, call?.authIndex, call?.AuthIndex]
        .find(index => typeof index === 'string' && index.trim())?.trim()
      const entry = quota.entries.get(authIndex)
      if (!entry) return json(res, 404, { error: 'Unknown account' })
      return handleApiCall(res, entry, call)
    } catch {
      console.error('magpie-cliproxy-usage: failed to handle a management request.')
      if (!res.headersSent && !res.destroyed) return json(res, 500, { error: 'Management request failed' })
    }
  })
}

function validateManagementKey(value) {
  const key = typeof value === 'string' ? value.trim() : ''
  if (!key || /[^!-~]/.test(key)) {
    throw new Error('managementKey must be a non-empty string of visible ASCII characters')
  }
  return key
}

async function readKeyFile(path) {
  let file
  try {
    file = await open(path, 'r')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
  try {
    if (((await file.stat()).mode & 0o777) !== 0o600) await file.chmod(0o600)
    const value = (await file.readFile('utf8')).trim()
    return value ? validateManagementKey(value) : ''
  } finally {
    await file.close()
  }
}

async function resolveManagementKey(configDir, options = {}) {
  if (options.managementKey !== undefined) return validateManagementKey(options.managementKey)
  const env = process.env.MAGPIE_CLIPROXY_MANAGEMENT_KEY ?? process.env.MAGPIE_T3_MANAGEMENT_KEY
  if (env !== undefined) return validateManagementKey(env)

  const path = join(configDir, keyFileName)
  const primary = await readKeyFile(path)
  if (primary) return primary
  if (primary === null) {
    const legacy = await readKeyFile(join(configDir, legacyKeyFileName))
    if (legacy) return legacy
  }

  await mkdir(configDir, { recursive: true, mode: 0o700 })
  const temp = await mkdtemp(join(configDir, '.cliproxy-usage-'))
  const candidate = join(temp, 'candidate')
  const pending = path + '.pending'
  let published = false
  try {
    await writeFile(candidate, randomBytes(24).toString('base64url') + '\n', { mode: 0o600 })
    // Overlapping hosts share a fully written candidate, including during empty-file repair.
    try {
      await link(candidate, pending)
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
    }
    const generated = await readKeyFile(pending)
    const existing = await readKeyFile(path)
    if (existing) {
      published = true
      return existing
    }
    const replacement = join(temp, 'replacement')
    await writeFile(replacement, validateManagementKey(generated) + '\n', { mode: 0o600 })
    await rename(replacement, path)
    published = true
    return generated
  } finally {
    try {
      if (published) await rm(pending, { force: true })
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  }
}

function resolvePort(options = {}) {
  const raw = options.port === undefined
    ? process.env.MAGPIE_CLIPROXY_USAGE_PORT ?? process.env.MAGPIE_T3_USAGE_PORT ?? 3426
    : options.port
  const port = typeof raw === 'string' && raw.length > 0 && !/[^0-9]/.test(raw) ? Number(raw) : raw
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid port. Expected an integer or decimal digit string in 1..65535')
  }
  return port
}

function isLoopback(host) {
  if (isIP(host) === 4) return host.startsWith('127.')
  return isIP(host) === 6 && parseUrl(`http://[${host}]/`)?.hostname === '[::1]'
}

function resolveHost(options) {
  const raw = options.host === undefined
    ? process.env.MAGPIE_CLIPROXY_USAGE_HOST ?? '127.0.0.1'
    : options.host
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('host must be a non-empty string')
  const host = raw.trim()
  const allowNonLoopback = readBoolean(options.allowNonLoopback, 'allowNonLoopback')
  if (allowNonLoopback) console.warn('magpie-cliproxy-usage: allowNonLoopback is enabled')
  if (host.toLowerCase() === 'localhost') return '127.0.0.1'
  if (!isLoopback(host) && !allowNonLoopback) {
    throw new Error('host must be a loopback address unless allowNonLoopback is true')
  }
  return host
}

async function tryListen(server, port, host) {
  return new Promise((resolveListen, rejectListen) => {
    function onError(err) {
      server.off('listening', onListening)
      if (err?.code === 'EADDRINUSE') resolveListen(false)
      else {
        const code = ['EACCES', 'EADDRNOTAVAIL', 'ENOTFOUND'].includes(err?.code) ? ` (${err.code})` : ''
        rejectListen(new Error(`magpie-cliproxy-usage: could not bind port ${port}${code}`))
      }
    }
    function onListening() {
      server.off('error', onError)
      resolveListen(true)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    try {
      server.listen(port, host)
    } catch (err) {
      server.off('error', onError)
      onError(err)
    }
  })
}

async function listenWithRetry(server, port, host, standalone) {
  async function bind() {
    if (await tryListen(server, port, host)) {
      if (!standalone) server.unref()
      return true
    }
    return false
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    if (await bind()) return
    if (attempt < 4) await new Promise(resolveDelay => setTimeout(resolveDelay, 250))
  }

  console.warn(`magpie-cliproxy-usage: port ${port} is in use (EADDRINUSE). Waiting to bind.`)
  function retry() {
    const timer = setTimeout(async () => {
      try {
        if (await bind()) console.info(`magpie-cliproxy-usage: bound port ${port} after waiting.`)
        else retry()
      } catch {
        console.error(`magpie-cliproxy-usage: failed to bind port ${port} while retrying.`)
      }
    }, 500)
    if (!standalone) timer.unref()
  }
  retry()
}

async function start(options = {}, standalone = false) {
  providerOptions(options)
  const port = resolvePort(options)
  const host = resolveHost(options)
  const configDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'magpie')
  const managementKey = await resolveManagementKey(configDir, options)

  const server = createUsageServer({
    managementKey,
    options,
    loadCards: async () => {
      const { addr } = JSON.parse(await readFile(join(configDir, 'gateway.json'), 'utf8'))
      const address = typeof addr === 'string' && /^(\[[^\]]+\]|[^:]+):([0-9]+)$/.exec(addr)
      if (!address) throw new Error('Missing local Magpie gateway address')
      const [, configuredHost, portText] = address
      const gwPort = resolvePort({ port: portText })
      const gwHost = configuredHost.startsWith('[') ? '[::1]' : '127.0.0.1'
      const response = await fetch(`http://${gwHost}:${gwPort}/v1/magpie/quotas/cards`, {
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
      })
      if (!response.ok) throw new Error('Local Magpie returned HTTP ' + response.status)
      const { data } = await response.json()
      if (!Array.isArray(data)) throw new Error('Invalid Magpie quota response')
      return data
    },
  })

  await listenWithRetry(server, port, host, standalone)
}

let startup
export async function MagpieCliProxyUsagePlugin(_input, options) {
  startup ??= start(options).catch(err => {
    startup = undefined
    throw err
  })
  await startup
  return {}
}

export default {
  id: 'magpie-cliproxy-usage',
  server: MagpieCliProxyUsagePlugin,
}

export { createUsageServer, resolveManagementKey, resolvePort }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await start(undefined, true)
}
