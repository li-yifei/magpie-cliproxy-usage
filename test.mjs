import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createUsageServer, resolveManagementKey } from './index.mjs'

async function withServer(loadCards, fn) {
  const managementKey = 'test-secret-key'
  const server = createUsageServer({ loadCards, managementKey })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const base = `http://127.0.0.1:${port}`
  try {
    await fn({ base, managementKey })
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

test('rejects missing or wrong bearer token', async () => {
  await withServer(async () => [], async ({ base }) => {
    const res = await fetch(`${base}/v0/management/auth-files`)
    assert.equal(res.status, 401)
    const bad = await fetch(`${base}/v0/management/auth-files`, {
      headers: { Authorization: 'Bearer wrong' },
    })
    assert.equal(bad.status, 401)
  })
})

test('aggregates native codex subscription quotas in CLIProxyAPI format', async () => {
  const reset = '2026-12-01T00:00:00Z'
  const cards = [
    {
      provider: 'codex',
      kind: 'subscription',
      windows: [
        { name: '5 hours', used: 20, resetsAt: reset },
        { name: '7 days', used: 40, resetsAt: reset },
      ],
    },
    {
      provider: 'codex',
      kind: 'subscription',
      windows: [
        { name: '5 hours', used: 60, resetsAt: reset },
        { name: '7 days', used: 50, resetsAt: '2026-12-02T00:00:00Z' },
      ],
    },
    {
      provider: 's2a/codex',
      kind: 'subscription',
      windows: [{ name: '7 days', used: 99, resetsAt: reset }],
    },
  ]

  await withServer(async () => cards, async ({ base, managementKey }) => {
    const headers = {
      Authorization: `Bearer ${managementKey}`,
      'Content-Type': 'application/json',
    }

    const listRes = await fetch(`${base}/v0/management/auth-files`, { headers })
    assert.equal(listRes.status, 200)
    const listBody = await listRes.json()
    assert.deepEqual(listBody.files.map(f => f.id), ['native-codex'])

    const usageRes = await fetch(`${base}/v0/management/api-call`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        auth_index: 'native-codex',
        method: 'GET',
        url: 'https://chatgpt.com/backend-api/wham/usage',
      }),
    })
    assert.equal(usageRes.status, 200)
    const usageOuter = await usageRes.json()
    assert.equal(usageOuter.status_code, 200)
    const { rate_limit } = JSON.parse(usageOuter.body)
    assert.equal(rate_limit.primary_window.used_percent, 40)
    assert.equal(rate_limit.primary_window.reset_at, Math.floor(Date.parse(reset) / 1000))
    assert.equal(rate_limit.secondary_window.used_percent, 45)
    assert.equal(rate_limit.secondary_window.reset_at, null)
  })
})

test('resolveManagementKey auto-generates key when missing and respects legacy file', async () => {
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
