(() => {
  const DEFAULTS = {
    port: 3426,
    host: '127.0.0.1',
    includeProviders: [],
    excludeProviders: [],
    includeRemote: false,
    allowNonLoopback: false,
  }

  const I18N = {
    en: {
      title: 'CLIProxyAPI Usage',
      subtitle: 'Expose local Magpie quota snapshots through a CLIProxyAPI-compatible management API.',
      endpointHeading: 'Endpoint',
      copyBtn: 'Copy URL',
      copied: 'Copied',
      keyHint: 'Management key file: <code>~/.config/magpie/cliproxy-usage-management.key</code> (auto-generated on first start).',
      settingsHeading: 'Settings',
      portLabel: 'Port',
      hostLabel: 'Host',
      includeLabel: 'Include Providers (empty = all local supported)',
      includeHint: 'Comma-separated provider IDs or CLIProxyAPI types. Exact remote IDs (e.g. s2a/codex) opt in that remote card.',
      excludeLabel: 'Exclude Providers',
      includeRemoteLabel: 'Include remote Magpie cards',
      includeRemoteHint: 'Expose cards forwarded from remote Magpie instances (such as s2a/codex).',
      allowNonLoopbackLabel: 'Allow non-loopback host',
      allowNonLoopbackHint: 'Required to bind outside 127.0.0.1 / ::1 / localhost. Use TLS or a protected tunnel for remote access.',
      saveBtn: 'Save & Restart',
      resetBtn: 'Reset Defaults',
      saving: 'Saving…',
      saved: 'Saved. Magpie restarted the plugin with the new settings.',
      invalidPort: 'Port must be an integer between 1 and 65535.',
      invalidHost: 'Host must not be empty.',
      noBridge: 'Magpie options bridge is unavailable in this view.',
    },
    zh: {
      title: 'CLIProxyAPI 用量接口',
      subtitle: '将本机 Magpie 订阅额度快照暴露为 CLIProxyAPI 兼容的管理接口。',
      endpointHeading: '接口地址',
      copyBtn: '复制地址',
      copied: '已复制',
      keyHint: '管理密钥文件：<code>~/.config/magpie/cliproxy-usage-management.key</code>（首次启动自动生成）。',
      settingsHeading: '配置',
      portLabel: '端口号',
      hostLabel: '监听地址',
      includeLabel: '仅提供这些供应商（留空 = 本机全部支持的供应商）',
      includeHint: '逗号分隔的 Magpie 供应商 ID 或 CLIProxyAPI 类型；填写完整远端 ID（如 s2a/codex）可单独放行。',
      excludeLabel: '排除这些供应商',
      includeRemoteLabel: '包含远端 Magpie 卡片',
      includeRemoteHint: '默认包含由远端 Magpie 转发的额度卡片（如 s2a/codex）。',
      allowNonLoopbackLabel: '允许非回环地址监听',
      allowNonLoopbackHint: '绑定 127.0.0.1 / ::1 / localhost 以外地址时必须勾选；远端访问请配合加密隧道或反代 TLS。',
      saveBtn: '保存并重启插件',
      resetBtn: '恢复默认',
      saving: '保存中…',
      saved: '已保存，Magpie 已按新配置重启插件。',
      invalidPort: '端口号必须是 1 到 65535 之间的整数。',
      invalidHost: '监听地址不能为空。',
      noBridge: '当前视图无法访问 Magpie 配置桥接接口。',
    },
  }

  const $ = id => document.getElementById(id)
  const portInput = $('portInput')
  const hostInput = $('hostInput')
  const includeInput = $('includeInput')
  const excludeInput = $('excludeInput')
  const includeRemoteInput = $('includeRemoteInput')
  const allowNonLoopbackInput = $('allowNonLoopbackInput')
  const endpointUrl = $('endpointUrl')
  const statusEl = $('status')
  const saveBtn = $('saveBtn')
  const resetBtn = $('resetBtn')
  const copyBtn = $('copyBtn')
  const chips = [...document.querySelectorAll('#includeChips .chip')]

  let savedExtras = {}
  let dict = I18N.en

  function pickLang(raw) {
    const s = String(raw || navigator.language || '').toLowerCase()
    return s.startsWith('zh') ? I18N.zh : I18N.en
  }

  function applyLocale(raw) {
    dict = pickLang(raw)
    for (const key of [
      'title', 'subtitle', 'endpointHeading', 'copyBtn', 'settingsHeading',
      'portLabel', 'hostLabel', 'includeLabel', 'includeHint', 'excludeLabel',
      'includeRemoteLabel', 'includeRemoteHint', 'allowNonLoopbackLabel',
      'allowNonLoopbackHint', 'saveBtn', 'resetBtn',
    ]) {
      const el = $(key)
      if (el) el.textContent = dict[key]
    }
    $('keyHint').innerHTML = dict.keyHint
  }

  function parseList(raw) {
    return [...new Set(String(raw || '').split(/[\s,]+/).map(s => s.trim()).filter(Boolean))]
  }

  function formatEndpoint(host, port) {
    const h = (host || '127.0.0.1').trim()
    const bracketed = h.includes(':') && !h.startsWith('[') ? `[${h}]` : h
    return `http://${bracketed}:${port || 3426}`
  }

  function syncEndpoint() {
    endpointUrl.textContent = formatEndpoint(hostInput.value, portInput.value)
  }

  function syncChips() {
    const items = new Set(parseList(includeInput.value).map(s => s.toLowerCase()))
    for (const chip of chips) {
      chip.classList.toggle('active', items.has(chip.dataset.provider))
    }
  }

  function setStatus(msg, kind = '') {
    statusEl.textContent = msg
    statusEl.className = 'status' + (kind ? ' ' + kind : '')
  }

  function fill(opts) {
    const o = { ...DEFAULTS, ...(opts && typeof opts === 'object' ? opts : {}) }
    savedExtras = {}
    for (const [k, v] of Object.entries(o)) {
      if (!(k in DEFAULTS)) savedExtras[k] = v
    }
    portInput.value = String(o.port ?? DEFAULTS.port)
    hostInput.value = String(o.host ?? DEFAULTS.host)
    includeInput.value = Array.isArray(o.includeProviders) ? o.includeProviders.join(', ') : ''
    excludeInput.value = Array.isArray(o.excludeProviders) ? o.excludeProviders.join(', ') : ''
    includeRemoteInput.checked = Boolean(o.includeRemote)
    allowNonLoopbackInput.checked = Boolean(o.allowNonLoopback)
    syncChips()
    syncEndpoint()
  }

  for (const chip of chips) {
    chip.addEventListener('click', () => {
      const list = parseList(includeInput.value)
      const p = chip.dataset.provider
      const idx = list.findIndex(x => x.toLowerCase() === p)
      if (idx >= 0) list.splice(idx, 1)
      else list.push(p)
      includeInput.value = list.join(', ')
      syncChips()
    })
  }

  includeInput.addEventListener('input', syncChips)
  portInput.addEventListener('input', syncEndpoint)
  hostInput.addEventListener('input', syncEndpoint)

  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(endpointUrl.textContent)
      copyBtn.textContent = dict.copied
      setTimeout(() => { copyBtn.textContent = dict.copyBtn }, 1200)
    } catch {}
  })

  resetBtn.addEventListener('click', () => {
    fill(DEFAULTS)
    setStatus('')
  })

  saveBtn.addEventListener('click', async () => {
    const port = Number(portInput.value.trim())
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return setStatus(dict.invalidPort, 'err')
    }
    const host = hostInput.value.trim()
    if (!host) {
      return setStatus(dict.invalidHost, 'err')
    }
    if (!window.magpie?.options?.set) {
      return setStatus(dict.noBridge, 'err')
    }
    const next = {
      ...savedExtras,
      port,
      host,
      includeProviders: parseList(includeInput.value),
      excludeProviders: parseList(excludeInput.value),
      includeRemote: includeRemoteInput.checked,
      allowNonLoopback: allowNonLoopbackInput.checked,
    }
    saveBtn.disabled = true
    setStatus(dict.saving)
    try {
      await window.magpie.options.set(next)
      setStatus(dict.saved, 'ok')
    } catch (err) {
      setStatus(err?.message || String(err), 'err')
    } finally {
      saveBtn.disabled = false
    }
  })

  applyLocale('')
  fill(DEFAULTS)

  ;(async () => {
    try {
      const info = await window.magpie?.ready
      if (info?.lang) applyLocale(info.lang)
    } catch {}
    try {
      const opts = await window.magpie?.options?.get?.()
      if (opts && typeof opts === 'object') fill(opts)
    } catch {}
  })()
})()
