# magpie-cliproxy-usage

A [Magpie](https://usemagpie.ai) plugin that exposes your active Magpie subscription quota snapshots through a **CLIProxyAPI-compatible management usage API** (`/v0/management/auth-files` and `/v0/management/api-call`).

Any client that supports CLIProxyAPI usage/quota polling (such as T3 Code, menu-bar quota monitors, or custom scripts) can read quotas for **Codex**, **Claude**, **Antigravity**, and **Grok (xAI)** directly from your local Magpie gateway.

> 将本机 Magpie 所有有效订阅供应商的额度快照转译为 **CLIProxyAPI 兼容格式** 的用量管理接口，可在 Magpie 插件页直接点击 **Options** 配置端口与要暴露/排除的供应商。

## Install

In Magpie:

- **Settings → Plugins → Discover → Unofficial** → search `magpie-cliproxy-usage` → **Install**

Or via CLI:

```sh
magpie plugin add github:li-yifei/magpie-cliproxy-usage
```

## Configuration (GUI & CLI)

Open **Settings → Plugins → Installed**, find **magpie-cliproxy-usage**, and click **Options** to edit its JSON config (saving automatically restarts the plugin with the new settings):

```json
{
  "port": 3426,
  "host": "127.0.0.1",
  "includeProviders": [],
  "excludeProviders": [],
  "includeRemote": false
}
```

Or configure via CLI:

```sh
magpie plugin options magpie-cliproxy-usage '{"port":3426,"excludeProviders":["claude"]}'
```

| Option | Env Variable | Default | Description |
| --- | --- | --- | --- |
| `port` | `MAGPIE_CLIPROXY_USAGE_PORT` | `3426` | Port the loopback usage server listens on (`1–65535`). |
| `host` | `MAGPIE_CLIPROXY_USAGE_HOST` | `127.0.0.1` | Bind address. |
| `managementKey` | `MAGPIE_CLIPROXY_MANAGEMENT_KEY` | `~/.config/magpie/cliproxy-usage-management.key` | Bearer token (auto-generated with mode `0600` on first run if absent). |
| `includeProviders` | — | `[]` (all) | Whitelist of Magpie provider IDs (e.g. `["codex", "claude", "agy-cli", "s2a/codex"]`) or CLIProxyAPI types (`"codex"`, `"claude"`, `"antigravity"`, `"xai"`). |
| `excludeProviders` | — | `[]` (none) | Blacklist of provider IDs or CLIProxyAPI types to hide. |
| `includeRemote` | — | `false` | Whether to expose remote-forwarded Magpie cards (e.g. `s2a/codex`). Explicitly naming a remote ID in `includeProviders` also includes it. |

## Supported Providers & Endpoints

All endpoints require `Authorization: Bearer <managementKey>`.

- `GET /v0/management/auth-files` — lists all enabled providers that have numeric quota windows.
- `GET /v0/management/providers` — lists every quota provider discovered from local Magpie along with its `enabled` state (handy for checking exact provider IDs).
- `POST /v0/management/api-call`:
  - **Codex** (`codex`): `GET https://chatgpt.com/backend-api/wham/usage` and `GET https://chatgpt.com/backend-api/wham/rate-limit-reset-credits`
  - **Claude** (`claude`): `GET https://api.anthropic.com/api/oauth/usage` (5-hour, 7-day, and weekly model-scoped limits)
  - **Antigravity** (`antigravity`, `agy-cli`): `POST https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary`
  - **Grok / xAI** (`grok`, `xai`): `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`

## Management Key

On first start, the plugin automatically generates a random Bearer token and saves it (mode `0600`) to:

```text
~/.config/magpie/cliproxy-usage-management.key
```

Configure your CLIProxyAPI-compatible client with:

- **Base URL**: `http://127.0.0.1:3426` (or your configured `port`)
- **Management Key**: contents of `~/.config/magpie/cliproxy-usage-management.key`

## License

MIT
