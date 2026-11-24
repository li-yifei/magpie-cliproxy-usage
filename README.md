# magpie-cliproxy-usage

A [Magpie](https://usemagpie.ai) plugin that exposes your local Magpie subscription quota snapshots through a **CLIProxyAPI-compatible management usage API** (`/v0/management/auth-files` and `/v0/management/api-call`).

Any client that supports CLIProxyAPI usage/quota polling (such as T3 Code, menu-bar quota monitors, or custom scripts) can read Magpie's local Codex subscription quotas directly from this endpoint.

> 将本机 Magpie 的订阅额度快照转译为 **CLIProxyAPI 兼容格式** 的用量管理接口（`/v0/management/auth-files` 与 `/v0/management/api-call`），供 T3 Code 或任何支持 CLIProxyAPI 额度查询的客户端读取。

## Install

In Magpie:

- **Settings → Plugins → Discover → Unofficial** → search `magpie-cliproxy-usage` → **Install**

Or via CLI:

```sh
magpie plugin add github:li-yifei/magpie-cliproxy-usage
```

## How It Works

1. The plugin starts a loopback HTTP listener on `127.0.0.1:3426` inside Magpie's plugin host.
2. On each request (cached for 15 seconds), it reads `/v1/magpie/quotas/cards` from the local Magpie gateway (`gateway.json`).
3. Native Codex subscription cards (`provider === "codex" && kind === "subscription"`) are aggregated into a single `native-codex` entry:
   - `5 hours` → `primary_window` (`limit_window_seconds: 18000`)
   - `7 days` → `secondary_window` (`limit_window_seconds: 604800`)
   - Multiple accounts are averaged with equal weight; `reset_at` is included only when all contributing accounts share the same reset timestamp.

## Management Key & Configuration

On first start, the plugin automatically generates a random Bearer token and saves it (mode `0600`) to:

```text
~/.config/magpie/cliproxy-usage-management.key
```

(Respects `XDG_CONFIG_HOME`; if an existing `t3-usage-management.key` is present, it is reused automatically.)

Configure your CLIProxyAPI-compatible client with:

- **Base URL**: `http://127.0.0.1:3426`
- **Management Key**: contents of `~/.config/magpie/cliproxy-usage-management.key`

### Optional Settings

You can override defaults via Magpie plugin options (`magpie plugin options magpie-cliproxy-usage '{"port":3426}'`) or environment variables:

| Option | Environment Variable | Default |
| --- | --- | --- |
| `port` | `MAGPIE_CLIPROXY_USAGE_PORT` | `3426` |
| `host` | `MAGPIE_CLIPROXY_USAGE_HOST` | `127.0.0.1` |
| `managementKey` | `MAGPIE_CLIPROXY_MANAGEMENT_KEY` | `~/.config/magpie/cliproxy-usage-management.key` |

## Supported Endpoints

All endpoints require `Authorization: Bearer <managementKey>`.

- `GET /v0/management/auth-files` — lists `native-codex` when local Codex subscription quotas are available.
- `POST /v0/management/api-call` — supports `GET https://chatgpt.com/backend-api/wham/usage` for `auth_index: "native-codex"`.
- `GET /v0/management/auth-files/models` — returns `501` (not applicable).

## Remote Quotas

Each plugin instance reads only from the Magpie gateway on the same host. To query quotas from a remote Magpie instance, install this plugin on that remote host and access its loopback port over a protected tunnel (e.g., SSH port forwarding or Tailscale).

## License

MIT
