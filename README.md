# OpenClaw Progress Plugin

[中文文档 / Chinese Documentation](./README.zh-CN.md)

`openclaw-progress-plugin` is a Feishu-first progress plugin for OpenClaw.

It helps users see **what the agent is doing right now** during long-running runs by:
- emitting structured progress events,
- aggregating run state,
- and updating a single message card in chat clients (Feishu first).

---

## What this plugin solves

Many users only see the final answer and cannot perceive intermediate execution steps.

This plugin adds visible progress checkpoints such as:
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
3. A target Feishu conversation id (`chat_id` by default)

---

## Install and load

### 1) Clone plugin repository

```bash
git clone https://github.com/cybersentia/openclaw-progress-plugin.git /opt/openclaw-progress-plugin
```

### 2) Configure OpenClaw to load this plugin

Add this into your OpenClaw config (example):

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
            "receiveIdType": "chat_id",
            "defaultConversationId": "oc_xxx",
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

## Security notes

- Do **not** hardcode secrets into source files.
- Store `appSecret` in secure config/secrets management.
- Restrict plugin allowlist in OpenClaw config.

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
