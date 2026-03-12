# OpenClaw Progress Plugin

[中文文档 / Chinese Documentation](./README.zh-CN.md)

`openclaw-progress-plugin` is a Feishu-first progress plugin for OpenClaw.

It turns long-running, opaque execution into visible progress by:
- emitting structured progress events,
- aggregating them into run state,
- and updating a single message card continuously in chat.

---

## TL;DR (Quick Start)

1. Clone this repository to your plugin directory.
2. Enable plugin loading and allow `openclaw-progress-plugin` in OpenClaw config.
3. Configure Feishu `appId` + `appSecret`, restart gateway, then run one test in DM/group.

If route binding is temporarily unavailable, set `feishu.defaultConversationId` as a short-term fallback.

---

## What this plugin solves

In default chat-agent flows, users often only see the final answer and cannot perceive intermediate execution.

This plugin adds visible checkpoints such as:
- tool call started
- tool call finished
- run completed / failed

So users no longer wait in a black box.

---

## Repository layout

- `progress-schema.ts`: unified progress event schema
- `progress-state.ts`: run state model
- `reducer.ts`: event → run state reducer
- `progress-hub.ts`: throttled dispatch hub
- `progress-adapter.ts`: adapter interface
- `web-adapter.ts`: Web adapter skeleton
- `feishu-adapter.ts`: Feishu card update adapter
- `feishu-publisher.ts`: Feishu HTTP publisher (token + send/update)
- `plugin.ts`: OpenClaw plugin entry (hook wiring)
- `openclaw.plugin.json`: plugin manifest and config schema

---

## Prerequisites

1. A deployed OpenClaw gateway
2. Feishu app credentials:
   - `appId`
   - `appSecret`
3. A target Feishu conversation target (normally resolved automatically)

---

## Install and load

### 1) Clone plugin repository

```bash
git clone https://github.com/cybersentia/openclaw-progress-plugin.git /opt/openclaw-progress-plugin
```

### 2) Configure OpenClaw to load this plugin

```json
{
  "plugins": {
    "enabled": true,
    "load": {
      "paths": ["/opt/openclaw-progress-plugin"]
    },
    "allow": ["openclaw-progress-plugin"],
    "entries": {
      "openclaw-progress-plugin": {
        "enabled": true,
        "config": {
          "feishu": {
            "enabled": true,
            "appId": "cli_xxx",
            "appSecret": "xxx",
            "timeoutMs": 10000
          },
          "throttle": {
            "minEmitIntervalMs": 1000,
            "heartbeatIntervalMs": 5000
          }
        }
      }
    }
  }
}
```

### 3) Restart OpenClaw gateway

Restart your deployed OpenClaw gateway so plugin discovery reloads.

---

## Configuration reference

### `config.feishu`

| Field | Type | Required | Default | Notes |
|---|---|---:|---|---|
| `enabled` | boolean | no | `true` | Enable/disable Feishu adapter |
| `appId` | string | yes | - | Feishu app id |
| `appSecret` | string | yes | - | Feishu app secret |
| `baseUrl` | string | no | `https://open.feishu.cn` | Feishu OpenAPI base URL |
| `timeoutMs` | number | no | `10000` | HTTP timeout |
| `defaultConversationId` | string | no | unset | Fallback route target when normal route binding is missing |
| `stateFile` | string | no | `.openclaw-progress-plugin-state.json` | Persisted route/run/message state path |
| `runMessageTtlMs` | number | no | `1800000` | TTL for persisted run-message binding |

### `config.throttle`

| Field | Type | Required | Default | Notes |
|---|---|---:|---|---|
| `minEmitIntervalMs` | number | no | `1000` | Minimum emit interval |
| `heartbeatIntervalMs` | number | no | `5000` | Heartbeat checkpoint interval |

---

## Route & receive-id behavior (important)

The plugin supports both Feishu route types:

- `chat_id` (e.g. `oc_xxx`) → sent with `receive_id_type=chat_id`
- `open_id` (e.g. `ou_xxx`) → sent with `receive_id_type=open_id`

DM scenarios may expose only open-id-like values in canonical hook context. Current implementation supports this by allowing `open_id` route fallback and carrying `receiveIdType` through emit.

### Normalization rule

When route type is `open_id`, persisted/restored and newly bound route ids are normalized to `ou_...` format. `user:ou_...` is rewritten to `ou_...` before Feishu API calls.

---

## Current hook coverage

From `plugin.ts`, the plugin currently maps these typed hooks:
- `message_received` (captures session→conversation route)
- `before_tool_call` (emits `tool_start`)
- `after_tool_call` (emits `tool_end` or `failed`)
- `agent_end` (emits `completed` or `failed`)

This already gives strong user-visible progress with zero OpenClaw core code changes.

---

## Feishu behavior

For each run:
1. first event sends one interactive card,
2. next events update the same message,
3. final state is rendered when run ends.

This minimizes message spam and keeps progress readable.

---

## Troubleshooting

### Symptom: route missing

Log examples:
- `skip route bind: missing conversationId in message_received`
- `skip before_tool_call/after_tool_call: route not found`

Action:
- temporarily set `feishu.defaultConversationId` for continuity,
- then fix upstream canonical mapping so `conversationId` is available in hooks.

### Symptom: Feishu invalid receive_id

Log example:
- `code=230001 invalid receive_id`

Action:
- verify id type matches target (`oc_...` for `chat_id`, `ou_...` for `open_id`),
- verify target exists and bot has permission in that chat/user scope.

### Symptom: open_id rejected (`99992351`)

Log example:
- `not a valid {open_id}`
- invalid id contains `user:ou_...`

Action:
- use current version with open_id normalization,
- if needed, remove stale state file and restart once.

---

## Security notes

- Do **not** hardcode secrets into source files.
- Store `appSecret` in secure config/secrets management.
- Restrict plugin allowlist in OpenClaw config.

---

## Changelog highlights

- **PR #28**: support DM `open_id` route fallback when `chat_id` is unavailable in canonical hook context.
- **PR #29**: normalize persisted/bound `open_id` route ids (`user:ou_...` → `ou_...`) to prevent Feishu invalid-open-id failures after restart.

---

## Limitations and next steps

Current implementation focuses on high-value checkpoints (tool + final).

If you need finer granularity (e.g., model resolve / prompt build), extend hook mapping or emit more lifecycle events.

Potential next steps:
- add Slack/Telegram adapters
- richer phase timeline in card UI
- per-channel routing strategy

---

## License

MIT
