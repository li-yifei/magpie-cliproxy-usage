import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { createUsageServer, resolveManagementKey, resolvePort } from './index.mjs'

const management = '/v0/management/'
const codexUsage = 'https://chatgpt.com/backend-api/wham/usage'
const claudeUsage = 'https://api.anthropic.com/api/oauth/usage'
const grokUsage = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits'

test('declares page plugin manifest and options without gateway middleware', async () => {
  const manifest = JSON.parse(await readFile(new URL('package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.version, '0.4.0')
  assert.ok(manifest.keywords.includes('magpie-page'))
  assert.equal(manifest.magpie.options.allowNonLoopback, false)
  assert.equal(manifest.magpie.middleware, undefined)
  assert.ok(!manifest.files.includes('options.middleware.js'))
  assert.equal(manifest.magpie.page.file, 'page/index.html')
  assert.equal(manifest.magpie.page.icon, 'page/icon.svg')
  assert.ok(manifest.files.includes('page'))
  const html = await readFile(new URL(manifest.magpie.page.file, import.meta.url), 'utf8')
  assert.ok(html.includes('_magpie/bridge.js'))
  const icon = await readFile(new URL(manifest.magpie.page.icon, import.meta.url), 'utf8')
  assert.ok(icon.includes('<svg'))
})

function listen(server, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, () => {
      server.off('error', reject)
      resolve(server.address().port)
    })
  })
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close(err => err ? reject(err) : resolve())
    server.closeAllConnections()
  })
}

async function withServer(loadCards, options, fn) {
  const managementKey = 'test-secret-key'
  const server = createUsageServer({ loadCards, managementKey, options })
  const port = await listen(server)
  const base = `http://127.0.0.1:${port}`
  const headers = {
    Authorization: `Bearer ${managementKey}`,
    'Content-Type': 'application/json',
  }
  try {
    const get = route => fetch(base + management + route, { headers })
    const call = (id, url, method = 'GET', index = 'auth_index') => fetch(base + management + 'api-call', {
      method: 'POST',
      headers,
      body: JSON.stringify({ [index]: id, url, method }),
    })
    await fn({ base, headers, managementKey, get, call })
  } finally {
    await close(server)
  }
}

async function payload(res) {
  assert.equal(res.status, 200)
  const envelope = await res.json()
  assert.equal(envelope.status_code, 200)
  assert.deepEqual(envelope.header, {})
  return JSON.parse(envelope.body)
}

const sampleCards = [
  {
    provider: 'codex',
    name: 'Codex',
    plan: 'prolite',
    user: 'alice@example.com',
    kind: 'subscription',
    windows: [
      { name: '5 hours', used: 20, resetsAt: '2026-12-01T00:00:00Z' },
      { name: '7 days', used: 40, resetsAt: '2026-12-05T00:00:00Z' },
    ],
    resets: {
      each: [{ id: 'credit-1', until: '2026-12-10T00:00:00Z' }],
    },
  },
  {
    provider: 'claude',
    name: 'Claude Code',
    user: 'alice@example.com',
    kind: 'subscription',
    windows: [
      { name: '5 hours', used: 22, resetsAt: '2026-12-01T05:00:00Z' },
      { name: '7 days', used: 4, resetsAt: '2026-12-07T00:00:00Z' },
      { name: '7 days · Fable', used: 5, resetsAt: '2026-12-07T00:00:00Z' },
    ],
  },
  {
    provider: 'agy-cli',
    name: 'Antigravity',
    user: 'alice@gmail.com',
    kind: 'subscription',
    windows: [
      { name: '5 hours', used: 10, resetsAt: '2026-12-01T05:00:00Z', pool: 'Gemini' },
      { name: '7 days', used: 25, resetsAt: '2026-12-07T00:00:00Z', pool: 'Claude & GPT' },
    ],
  },
  {
    provider: 'grok',
    name: 'Grok',
    kind: 'subscription',
    windows: [
      { name: 'Rate limit', used: 100 },
      { name: 'On-demand', used: 75 },
      { name: 'Month', used: 33, resetsAt: '2026-12-31T00:00:00Z' },
    ],
  },
  {
    provider: 's2a/codex',
    name: 'Codex · Remote',
    from: 'Remote magpie',
    kind: 'subscription',
    windows: [{ name: '7 days', used: 5, resetsAt: '2026-12-06T00:00:00Z' }],
  },
  {
    provider: 'cloudflare-workers-ai',
    name: 'Cloudflare Workers AI',
    kind: 'subscription',
    windows: [{ name: 'Neurons/day', used: 0, text: true }],
  },
]

test('requires a valid key and accepts either management authentication header', async () => {
  await withServer(async () => [], {}, async ({ base, managementKey }) => {
    const res = await fetch(`${base}/v0/management/auth-files`)
    assert.equal(res.status, 401)
    const bad = await fetch(`${base}/v0/management/auth-files`, {
      headers: { Authorization: 'Bearer wrong' },
    })
    assert.equal(bad.status, 401)
    for (const headers of [
      { Authorization: `bEaReR ${managementKey}` },
      { 'X-Management-Key': managementKey },
    ]) {
      assert.equal((await fetch(base + management + 'auth-files', { headers })).status, 200)
    }
    const wrong = await fetch(base + management + 'auth-files', {
      headers: { 'X-Management-Key': managementKey.slice(0, -1) + 'x' },
    })
    assert.equal(wrong.status, 401)
  })
})

test('exposes all local supported providers by default and skips remote/text-only', async () => {
  await withServer(async () => sampleCards, {}, async ({ base, headers }) => {
    const listRes = await fetch(`${base}/v0/management/auth-files`, { headers })
    assert.equal(listRes.status, 200)
    const { files } = await listRes.json()
    assert.deepEqual(files.map(f => [f.id, f.provider]), [
      ['native-codex', 'codex'],
      ['magpie-claude', 'claude'],
      ['magpie-agy-cli', 'antigravity'],
      ['magpie-grok', 'xai'],
    ])
    for (const file of files) {
      assert.equal(file.name, file.id)
      assert.equal(file.auth_index, file.id)
      assert.equal(file.type, file.provider)
      assert.equal(file.status, 'active')
      assert.equal(file.disabled, false)
    }

    // Codex usage + reset credits
    const codexRes = await fetch(`${base}/v0/management/api-call`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        authIndex: 'native-codex',
        method: 'get',
        url: 'https://chatgpt.com/backend-api/wham/usage',
      }),
    })
    const codexBody = await payload(codexRes)
    assert.equal(codexBody.plan_type, 'prolite')
    assert.equal(codexBody.rate_limit.primary_window.used_percent, 20)
    assert.equal(codexBody.rate_limit.secondary_window.used_percent, 40)

    const creditsRes = await fetch(`${base}/v0/management/api-call`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        auth_index: 'native-codex',
        method: 'gEt',
        url: 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits',
      }),
    })
    assert.equal(creditsRes.status, 501)

    // Claude usage
    const claudeRes = await fetch(`${base}/v0/management/api-call`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        AuthIndex: 'magpie-claude',
        method: 'GET',
        url: 'https://API.ANTHROPIC.COM:443/api/oauth/usage?ignored=1',
      }),
    })
    const claudeBody = await payload(claudeRes)
    assert.equal(claudeBody.five_hour.utilization, 22)
    assert.equal(claudeBody.seven_day.utilization, 4)
    assert.equal(claudeBody.limits[0].scope.model.display_name, 'Fable')

    // Antigravity summary
    const agyRes = await fetch(`${base}/v0/management/api-call`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        auth_index: 'magpie-agy-cli',
        method: 'pOsT',
        url: 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary?version=1',
        data: JSON.stringify({ project: 'magpie' }),
      }),
    })
    const agyBody = await payload(agyRes)
    assert.equal(agyBody.groups.length, 2)
    assert.equal(agyBody.groups[0].buckets[0].bucketId, 'gemini-5h')
    assert.ok(Math.abs(agyBody.groups[0].buckets[0].remainingFraction - 0.9) < 1e-6)
    assert.equal(agyBody.groups[1].buckets[0].bucketId, '3p-weekly')

    // Grok / xAI
    const grokRes = await fetch(`${base}/v0/management/api-call`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        auth_index: 'magpie-grok',
        method: 'GET',
        url: 'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
      }),
    })
    const grokBody = await payload(grokRes)
    assert.equal(grokBody.config.creditUsagePercent, 33)
    assert.equal(grokBody.config.currentPeriod.type, 'USAGE_PERIOD_TYPE_MONTHLY')
  })
})

test('respects includeProviders, excludeProviders, and includeRemote options', async () => {
  for (const options of [
    { includeProviders: ['codex'] },
    { includeProviders: ['codex', ' S2A/CODEX '], excludeProviders: ['s2a/codex'] },
  ]) {
    await withServer(async () => sampleCards, options, async ({ base, headers }) => {
      const { files } = await (await fetch(`${base}/v0/management/auth-files`, { headers })).json()
      assert.deepEqual(files.map(f => f.id), ['native-codex'])
    })
  }

  await withServer(
    async () => sampleCards,
    { excludeProviders: ['claude', 'grok'], includeRemote: true },
    async ({ base, headers }) => {
      const { files } = await (await fetch(`${base}/v0/management/auth-files`, { headers })).json()
      assert.deepEqual(files.map(f => f.provider), ['codex', 'antigravity', 'codex'])
    },
  )

  await withServer(
    async () => sampleCards,
    { includeProviders: ['claude', ' S2A/CODEX '] },
    async ({ base, headers }) => {
      const { files } = await (await fetch(`${base}/v0/management/auth-files`, { headers })).json()
      assert.deepEqual(files.map(f => f.provider), ['claude', 'codex'])
    },
  )
})

test('accepts only ports in range as integers or decimal digit strings', () => {
  assert.equal(resolvePort({ port: 4000 }), 4000)
  assert.equal(resolvePort({ port: '00080' }), 80)
  for (const port of [true, [4000], 1.5, '', ' ', '1.0', '0x10', '1e3', '12\n', 0, 65536, null]) {
    assert.throws(() => resolvePort({ port }), /Invalid port/)
  }

  assert.equal(resolvePort({ port: 1 }), 1)
  assert.equal(resolvePort({ port: '65535' }), 65535)
})

test('validates provider options and management keys by type', async () => {
  for (const [name, values] of [
    ['includeRemote', ['false', 0, null]],
    ['includeProviders', ['codex', [7], [null], null]],
    ['excludeProviders', [{}, [true], null]],
  ]) {
    for (const value of values) {
      assert.throws(() => createUsageServer({
        loadCards: async () => [], managementKey: 'test-key', options: { [name]: value },
      }), new RegExp(name))
    }
  }
  for (const managementKey of [undefined, null, true, [], '', ' ', 'bad\nkey', 'bad key']) {
    assert.throws(() => createUsageServer({ loadCards: async () => [], managementKey }), /managementKey/)
  }
})

test('repairs an empty primary key and secures key files across concurrent starts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'magpie-keys-'))
  const keyPath = join(dir, 'cliproxy-usage-management.key')
  const legacyPath = join(dir, 't3-usage-management.key')
  try {
    const keys = await Promise.all(Array.from({ length: 8 }, () => resolveManagementKey(dir)))
    assert.equal(new Set(keys).size, 1)
    assert.match(keys[0], /^[a-z0-9_-]{32}$/i)
    assert.equal((await readFile(keyPath, 'utf8')).trim(), keys[0])
    assert.equal((await stat(keyPath)).mode & 0o777, 0o600)

    await rm(keyPath)
    await writeFile(legacyPath, 'legacy-key\n', { mode: 0o644 })
    assert.equal(await resolveManagementKey(dir), 'legacy-key')
    assert.equal((await stat(legacyPath)).mode & 0o777, 0o600)
    assert.equal(await resolveManagementKey(dir, { managementKey: ' provided-key ' }), 'provided-key')
    for (const managementKey of ['', 123, null]) {
      await assert.rejects(resolveManagementKey(dir, { managementKey }), /managementKey/)
    }

    await writeFile(keyPath, ' \n', { mode: 0o644 })
    const repaired = await Promise.all(Array.from({ length: 8 }, () => resolveManagementKey(dir)))
    assert.notEqual(repaired[0], 'legacy-key')
    assert.equal(new Set(repaired).size, 1)
    assert.equal((await readFile(keyPath, 'utf8')).trim(), repaired[0])
    assert.equal((await stat(keyPath)).mode & 0o777, 0o600)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('weights Codex windows per account and reports resets only on agreement', async () => {
  const resetAt = Math.floor(Date.now() / 1000) + 3600
  const window = { name: '5 hours', resetsAt: new Date(resetAt * 1000).toISOString() }
  const cards = [
    { provider: 'codex', user: 'first', windows: [
      { ...window, used: 0 },
      { ...window, used: 100, resetsAt: '2020-01-01T00:00:00Z' },
      { name: '7 days', used: 89 },
    ] },
    { provider: 'codex', user: 'second', windows: [{ ...window, used: 80 }] },
    { provider: 'codex', user: 'third', windows: [{ name: '7 days', used: 11, resetSecs: 1800 }] },
    { provider: 's2a/codex', windows: [{ name: '5 hours', used: 5, resetSecs: 1200 }] },
    { provider: 'another/codex', windows: [{ name: '5 hours', used: 5, resetSecs: 1200 }] },
    { provider: 'another/codex', windows: [{ name: '5 hours', used: 15, resetSecs: 1300 }] },
  ]
  await withServer(async () => cards, { includeRemote: true }, async ({ call, get }) => {
    const usage = await payload(await call('native-codex', codexUsage))
    assert.equal(usage.rate_limit.primary_window.used_percent, 40)
    assert.equal(usage.rate_limit.primary_window.reset_at, resetAt)
    assert.ok(usage.rate_limit.primary_window.reset_after_seconds >= 3599)
    assert.equal(usage.rate_limit.secondary_window.used_percent, 50)
    assert.equal(usage.rate_limit.secondary_window.reset_at, null)
    assert.equal(usage.rate_limit.secondary_window.reset_after_seconds, null)

    const { files } = await (await get('auth-files')).json()
    const remote = await payload(await call(files[1].auth_index, codexUsage))
    assert.ok(remote.rate_limit.primary_window.reset_after_seconds >= 1199)
    assert.ok(remote.rate_limit.primary_window.reset_after_seconds <= 1200)
    assert.ok(remote.rate_limit.primary_window.reset_at > Date.now() / 1000)
    const conflicting = await payload(await call(files[2].auth_index, codexUsage))
    assert.equal(conflicting.rate_limit.primary_window.used_percent, 10)
    assert.equal(conflicting.rate_limit.primary_window.reset_at, null)
  })
})

test('translates Antigravity pools and model windows independently', async () => {
  const reset = '2026-12-01T05:00:00.000Z'
  const cards = [
    { provider: 'agy-cli', windows: [
      { name: '5 hours', pool: 'Gemini', used: 23 },
      { name: '7 days', pool: 'Gemini 4 Argon', used: 67 },
      { name: '7 days', pool: 'Gemini Carbon', used: 78 },
      { name: '7 days', pool: 'Claude & GPT', used: 42 },
      { name: 'Gemini 3.1 Pro (High)', family: 'Gemini', pool: 'Gemini', used: 20, resetsAt: reset },
      { name: 'Gemini 3.1 Pro (High)', family: 'Gemini', pool: 'Gemini', used: 95 },
      { name: 'Claude Sonnet', modelId: 'claude-sonnet', used: 25 },
      { name: '5 hours', model: 'a-model', pool: 'Gemini', used: 90 },
    ] },
    { provider: 'agy-cli', windows: [
      { name: 'Gemini 3.1 Pro (High)', family: 'Gemini', used: 60, resetsAt: reset },
    ] },
    { provider: 'antigravity', windows: [
      { name: 'gemini-3-flash', used: 0 },
    ] },
  ]
  const summary = 'https://regional.example/v1internal:retrieveUserQuotaSummary?request=1'
  const models = 'https://another.example/internal:fetchAvailableModels'
  await withServer(async () => cards, {}, async ({ call, get }) => {
    const pools = await payload(await call('magpie-agy-cli', summary, 'Post'))
    assert.deepEqual(pools.groups.flatMap(g => g.buckets.map(b => b.bucketId)), [
      'gemini-5h', 'gemini-argon-weekly', 'gemini-carbon-weekly', '3p-weekly',
    ])
    assert.equal(pools.groups[0].buckets[0].remainingFraction, 0.77)
    const result = await payload(await call('magpie-agy-cli', models, 'post'))
    assert.deepEqual(result.models['gemini-3.1-pro-high'].quotaInfo, { remainingFraction: 0.6, resetTime: reset })
    assert.equal(result.models['claude-sonnet'].quotaInfo.remainingFraction, 0.75)
    assert.ok(result.models['a-model'])
    for (const url of [summary.replace('Summary?', 'Summary/extra?'), 'https://other.example/?x=:retrieveUserQuotaSummary']) {
      assert.equal((await call('magpie-agy-cli', url, 'POST')).status, 405)
    }
    const userinfo = await call('magpie-agy-cli', 'https://www.googleapis.com/oauth2/v2/userinfo')
    assert.deepEqual(await userinfo.json(), { status_code: 404, header: {}, body: '{"error":"Unavailable"}' })
    assert.equal((await call('magpie-antigravity', summary, 'POST')).status, 501)
    assert.ok((await payload(await call('magpie-antigravity', models, 'POST'))).models['gemini-3-flash'])
    assert.equal((await get('auth-files/models')).status, 501)
  })

  await withServer(async () => sampleCards, {}, async ({ call }) => {
    assert.equal((await call('magpie-agy-cli', models, 'POST')).status, 501)
  })
})

test('Grok translates only the current subscription allowance', async () => {
  const weekly = { name: '7 days', resetsAt: '2026-12-10T00:00:00Z' }
  const cards = [
    { provider: 'grok', windows: [{ ...weekly, used: 5 }, { ...weekly, used: 95 }] },
    { provider: 'grok', windows: [{ name: 'On-demand', used: 100 }, { ...weekly, used: 55 }] },
    { provider: 'grok', windows: [{ name: 'Rate limit', used: 100 }] },
    { provider: 'xai', windows: [{ name: 'Allowance', used: 18 }] },
  ]
  await withServer(async () => cards, {}, async ({ call }) => {
    const weeklyUsage = await payload(await call('magpie-grok', grokUsage))
    assert.deepEqual(weeklyUsage.config, {
      creditUsagePercent: 30,
      currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-12-10T00:00:00.000Z' },
    })
    const allowance = await payload(await call('magpie-xai', grokUsage))
    assert.deepEqual(allowance.config, { creditUsagePercent: 18, currentPeriod: {} })
  })
})

test('ignores malformed cards, aggregates discovery, and routes distinct provider IDs', async () => {
  const cards = [
    null,
    { provider: ['claude'] },
    { provider: 'codex', windows: {} },
    { provider: 'codex', windows: [null, 'broken', { used: 42 }, { name: '5 hours', used: '5' }] },
    { provider: 'codex', windows: [{ name: '5 hours', used: 23, resetsAt: {} }] },
    { provider: 'claude', windows: [{ name: 'unknown', used: 17 }] },
    { provider: 'grok', windows: [{ name: 'On-demand', used: 90 }] },
    { provider: 'a-b/codex', user: 'first remote', windows: [{ name: '5 hours', used: 11 }] },
    { provider: 'a/b/codex', user: 'second remote', windows: [{ name: '5 hours', used: 97 }] },
  ]
  await withServer(async () => cards, { includeRemote: true }, async ({ get, call }) => {
    const { providers } = await (await get('providers')).json()
    assert.deepEqual(providers.map(p => [p.provider, p.hasQuota, p.enabled, p.accounts]), [
      ['codex', true, true, 3],
      ['claude', true, false, 1],
      ['grok', true, false, 1],
      ['a-b/codex', true, true, 1],
      ['a/b/codex', true, true, 1],
    ])
    const { files } = await (await get('auth-files')).json()
    assert.equal(new Set(files.map(f => f.auth_index)).size, 3)
    for (const [name, used] of [['first remote', 11], ['second remote', 97]]) {
      const file = files.find(f => f.email === name)
      assert.equal((await payload(await call(file.auth_index, codexUsage))).rate_limit.primary_window.used_percent, used)
    }
  })
})

test('matches the exact Claude origin and path and rejects unsupported calls', async () => {
  await withServer(async () => sampleCards, {}, async ({ call }) => {
    for (const url of [
      claudeUsage + '-unrelated',
      claudeUsage.replace('https:', 'http:'),
      claudeUsage.replace('.com', '.com.example'),
      'https://example.com/?next=' + claudeUsage,
      'invalid URL',
    ]) {
      assert.equal((await call('magpie-claude', url)).status, 405)
    }
    assert.equal((await call('magpie-claude', claudeUsage, 'POST')).status, 405)
    assert.equal((await call('missing', claudeUsage)).status, 404)
  })
})

test('caps API request bodies at 16 KiB of UTF-8 and keeps split characters intact', async () => {
  const limit = 16 * 1024
  await withServer(async () => sampleCards, {}, async ({ base, headers }) => {
    const prefix = '{"auth_index":"native-codex","method":"GET","url":"' + codexUsage + '","extra":"'
    const exact = Buffer.from(prefix + '🪶' + 'x'.repeat(limit - Buffer.byteLength(prefix) - 6) + '"}')
    assert.equal(exact.length, limit)
    const res = await new Promise((resolve, reject) => {
      const req = request(base + management + 'api-call', { method: 'POST', headers }, resolve)
      req.once('error', reject)
      const split = Buffer.byteLength(prefix) + 1
      req.write(exact.subarray(0, split))
      req.end(exact.subarray(split))
    })
    assert.equal(res.statusCode, 200)
    await new Promise(resolve => { res.once('end', resolve); res.resume() })

    const send = body => fetch(base + management + 'api-call', { method: 'POST', headers, body })
    assert.equal((await send(exact.toString('utf8').replace('🪶', '🪶é'))).status, 413)
    assert.equal((await send(Buffer.alloc(limit + 1, 65))).status, 413)
    assert.equal((await send('{invalid JSON')).status, 400)
  })
})

test('caches failed gateway reads briefly and logs without exposing errors or credentials', async () => {
  let attempts = 0
  const messages = []
  const original = console.error
  console.error = (...args) => messages.push(args.join(' '))
  try {
    await withServer(async () => {
      attempts += 1
      if (attempts === 1) throw new Error('private details and test-secret-key')
      return sampleCards
    }, {}, async ({ get }) => {
      const failed = await Promise.all([get('providers'), get('auth-files'), get('providers')])
      assert.deepEqual(failed.map(r => r.status), [502, 502, 502])
      assert.equal((await get('providers')).status, 502)
      assert.equal(attempts, 1)
      assert.equal(messages.length, 1)
      assert.match(messages[0], /gateway/)
      assert.doesNotMatch(messages[0], /private details|test-secret-key/)
      await delay(3050)
      assert.equal((await get('providers')).status, 200)
      assert.equal(attempts, 2)
    })
  } finally {
    console.error = original
  }
})

function startPlugin(options, { configDir, keepAlive = false, env = {} } = {}) {
  const script = `
    import plugin from './index.mjs'
    if (${keepAlive}) process.stdin.resume()
    await plugin.server(null, ${JSON.stringify(options)})
    console.log('plugin initialized')
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('.', import.meta.url),
    env: {
      ...process.env,
      XDG_CONFIG_HOME: configDir,
      MAGPIE_CLIPROXY_USAGE_HOST: undefined,
      ...env,
    },
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  return {
    child,
    done: once(child, 'close'),
    get stdout() { return stdout },
    get stderr() { return stderr },
  }
}

async function waitFor(check, failure) {
  const deadline = Date.now() + 4000
  while (Date.now() < deadline) {
    if (await check()) return
    await delay(35)
  }
  assert.fail(failure())
}

test('rejects invalid bind options and warns on explicit non-loopback binds', async () => {
  const managementKey = 'host-test-key'
  for (const [options, reason] of [
    [{ host: '' }, /host must be a non-empty string/],
    [{ host: '  ' }, /host must be a non-empty string/],
    [{ host: 123 }, /host must be a non-empty string/],
    [{ host: null }, /host must be a non-empty string/],
    [{ host: '0.0.0.0' }, /host must be a loopback address/],
    [{ host: 'example.com' }, /host must be a loopback address/],
    [{ host: '127.example.com' }, /host must be a loopback address/],
    [{ host: '0.0.0.0', allowNonLoopback: 'false' }, /allowNonLoopback must be a boolean/],
    [{ host: '127.0.0.1', allowNonLoopback: null }, /allowNonLoopback must be a boolean/],
  ]) {
    const run = startPlugin({ managementKey, ...options })
    assert.notEqual((await run.done)[0], 0)
    assert.match(run.stderr, reason)
    assert.doesNotMatch(run.stderr, new RegExp(managementKey))
  }

  const reserved = createServer()
  const port = await listen(reserved, '0.0.0.0')
  await close(reserved)
  const run = startPlugin({ port, host: '0.0.0.0', allowNonLoopback: true, managementKey })
  assert.deepEqual(await run.done, [0, null])
  assert.match(run.stderr, /allowNonLoopback is enabled/)
  assert.doesNotMatch(run.stderr, new RegExp(managementKey))
})

test('replacement host binds after a retiring listener releases the port without probing it', { timeout: 12000 }, async () => {
  const requests = []
  const oldHost = createServer((req, res) => {
    requests.push(req.headers)
    res.end('{}')
  })
  const gateway = createServer((req, res) => {
    assert.equal(req.url, '/v1/magpie/quotas/cards')
    assert.equal(req.headers.authorization, undefined)
    assert.equal(req.headers['x-management-key'], undefined)
    res.end(JSON.stringify({ data: sampleCards }))
  })
  const configDir = await mkdtemp(join(tmpdir(), 'magpie-gateway-'))
  const managementKey = 'restart-test-key'
  const [port, gwPort] = await Promise.all([listen(oldHost), listen(gateway)])
  await mkdir(join(configDir, 'magpie'))
  await writeFile(join(configDir, 'magpie', 'gateway.json'), JSON.stringify({ addr: `127.0.0.1:${gwPort}` }))
  const run = startPlugin({ port, managementKey }, { configDir, keepAlive: true })

  try {
    await waitFor(() => run.stdout.includes('plugin initialized'), () => run.stderr)
    assert.match(run.stderr, /EADDRINUSE/)
    assert.deepEqual(requests, [])
    await close(oldHost)

    await waitFor(() => run.stdout.includes('bound port ' + port), () => run.stderr)
    const res = await fetch(`http://127.0.0.1:${port}` + management + 'auth-files', {
      headers: { 'X-Management-Key': managementKey },
    })
    assert.equal(res.status, 200)
    assert.equal((await res.json()).files[0].id, 'native-codex')
    assert.doesNotMatch(run.stdout + run.stderr, new RegExp(managementKey))
  } finally {
    run.child.kill()
    await run.done
    if (oldHost.listening) await close(oldHost)
    await close(gateway)
    await rm(configDir, { recursive: true, force: true })
  }
})

test('binds IPv6 loopback and lets the plugin process exit when idle or waiting on an occupied port', { timeout: 10000 }, async () => {
  const managementKey = 'ipv6-test-key'
  const oldHost = createServer()
  const port = await listen(oldHost, '::1')
  try {
    const blocked = startPlugin({ host: '::1', port, managementKey })
    assert.deepEqual(await blocked.done, [0, null])
    assert.match(blocked.stderr, /EADDRINUSE/)
  } finally {
    await close(oldHost)
  }

  const configDir = await mkdtemp(join(tmpdir(), 'magpie-ipv6-gateway-'))
  const gateway = createServer((_req, res) => res.end(JSON.stringify({ data: sampleCards })))
  const gatewayPort = await listen(gateway, '::1')
  await mkdir(join(configDir, 'magpie'))
  await writeFile(join(configDir, 'magpie', 'gateway.json'), JSON.stringify({ addr: `[::1]:${gatewayPort}` }))
  const run = startPlugin({ host: '::1', port, managementKey }, { configDir, keepAlive: true })
  try {
    await waitFor(() => run.stdout.includes('plugin initialized'), () => run.stderr)
    const url = `http://[::1]:${port}` + management + 'auth-files'
    assert.equal((await fetch(url)).status, 401)
    const res = await fetch(url, { headers: { Authorization: `Bearer ${managementKey}` } })
    assert.equal(res.status, 200)
    assert.equal((await res.json()).files[0].id, 'native-codex')
  } finally {
    run.child.kill()
    await run.done
    await close(gateway)
    await rm(configDir, { recursive: true, force: true })
  }
  const idle = startPlugin({ host: '::1', port, managementKey })
  assert.deepEqual(await idle.done, [0, null])
})
