import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createUsageServer, resolveManagementKey, resolvePort } from './index.mjs'

async function withServer(loadCards, options, fn) {
  const managementKey = 'test-secret-key'
  const server = createUsageServer({ loadCards, managementKey, options })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const base = `http://127.0.0.1:${port}`
  const headers = {
    Authorization: `Bearer ${managementKey}`,
    'Content-Type': 'application/json',
  }
  try {
    await fn({ base, headers, managementKey })
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
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
    windows: [{ name: 'Monthly', used: 33, resetsAt: '2026-12-31T00:00:00Z' }],
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

test('rejects missing or wrong bearer token', async () => {
  await withServer(async () => [], {}, async ({ base }) => {
    const res = await fetch(`${base}/v0/management/auth-files`)
    assert.equal(res.status, 401)
    const bad = await fetch(`${base}/v0/management/auth-files`, {
      headers: { Authorization: 'Bearer wrong' },
    })
    assert.equal(bad.status, 401)
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

    // Codex usage + reset credits
    const codexRes = await fetch(`${base}/v0/management/api-call`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        auth_index: 'native-codex',
        method: 'GET',
        url: 'https://chatgpt.com/backend-api/wham/usage',
      }),
    })
    const codexBody = JSON.parse((await codexRes.json()).body)
    assert.equal(codexBody.plan_type, 'prolite')
    assert.equal(codexBody.rate_limit.primary_window.used_percent, 20)
    assert.equal(codexBody.rate_limit.secondary_window.used_percent, 40)

    const creditsRes = await fetch(`${base}/v0/management/api-call`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        auth_index: 'native-codex',
        method: 'GET',
        url: 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits',
      }),
    })
    const creditsBody = JSON.parse((await creditsRes.json()).body)
    assert.equal(creditsBody.credits[0].id, 'credit-1')

    // Claude usage
    const claudeRes = await fetch(`${base}/v0/management/api-call`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        auth_index: 'magpie-claude',
        method: 'GET',
        url: 'https://api.anthropic.com/api/oauth/usage',
      }),
    })
    const claudeBody = JSON.parse((await claudeRes.json()).body)
    assert.equal(claudeBody.five_hour.utilization, 22)
    assert.equal(claudeBody.seven_day.utilization, 4)
    assert.equal(claudeBody.limits[0].scope.model.display_name, 'Fable')

    // Antigravity summary
    const agyRes = await fetch(`${base}/v0/management/api-call`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        auth_index: 'magpie-agy-cli',
        method: 'POST',
        url: 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
        data: JSON.stringify({ project: 'magpie' }),
      }),
    })
    const agyBody = JSON.parse((await agyRes.json()).body)
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
    const grokBody = JSON.parse((await grokRes.json()).body)
    assert.equal(grokBody.config.creditUsagePercent, 33)
  })
})

test('respects includeProviders, excludeProviders, and includeRemote options', async () => {
  await withServer(
    async () => sampleCards,
    { excludeProviders: ['claude', 'grok'], includeRemote: true },
    async ({ base, headers }) => {
      const { files } = await (await fetch(`${base}/v0/management/auth-files`, { headers })).json()
      assert.deepEqual(files.map(f => f.id), ['native-codex', 'magpie-agy-cli', 'magpie-s2a-codex'])
    },
  )

  await withServer(
    async () => sampleCards,
    { includeProviders: ['claude', 's2a/codex'] },
    async ({ base, headers }) => {
      const { files } = await (await fetch(`${base}/v0/management/auth-files`, { headers })).json()
      assert.deepEqual(files.map(f => f.id), ['magpie-claude', 'magpie-s2a-codex'])
    },
  )
})

test('resolveManagementKey and resolvePort validate and fallback properly', async () => {
  assert.equal(resolvePort({ port: 4000 }), 4000)
  assert.throws(() => resolvePort({ port: 70000 }))

  const dir = await mkdtemp(join(tmpdir(), 'magpie-cliproxy-usage-'))
  try {
    const generated = await resolveManagementKey(dir)
    assert.ok(generated.length >= 24)
    const saved = (await readFile(join(dir, 'cliproxy-usage-management.key'), 'utf8')).trim()
    assert.equal(saved, generated)

    const dir2 = await mkdtemp(join(tmpdir(), 'magpie-cliproxy-legacy-'))
    try {
      await writeFile(join(dir2, 't3-usage-management.key'), 'legacy-key\n')
      assert.equal(await resolveManagementKey(dir2), 'legacy-key')
    } finally {
      await rm(dir2, { recursive: true, force: true })
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
