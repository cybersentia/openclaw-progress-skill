# OpenClaw Progress Plugin

`openclaw-progress-plugin` 是一个面向 OpenClaw 的任务进度可视化插件，当前以飞书（Feishu）为优先渠道。

它把“长时间等待但不知道系统在做什么”变成可见进度：
- 产出结构化进度事件，
- 聚合为运行态状态，
- 在聊天端持续更新同一条进度卡片。

---

## TL;DR（快速开始）

1. 拉取本仓库到插件目录。
2. 在 OpenClaw 配置中启用插件加载，并允许 `openclaw-progress-plugin`。
3. 配置飞书 `appId` + `appSecret`，重启网关后做一次私聊/群聊实测。

如果暂时拿不到路由，可先设置 `feishu.defaultConversationId` 作为临时兜底。

---

## 解决的问题

默认对话体验里，用户通常只能看到最终结果，无法感知中间执行过程。

该插件会把关键阶段显式展示出来，例如：
- 工具开始执行
- 工具执行完成
- 任务完成 / 失败

从而把“黑盒等待”变成“可感知进度”。

---

## 仓库结构

- `progress-schema.ts`：统一进度事件结构定义
- `progress-state.ts`：运行状态模型
- `reducer.ts`：事件归约为状态
- `progress-hub.ts`：带节流的分发中枢
- `progress-adapter.ts`：渠道适配器接口
- `web-adapter.ts`：Web 适配器骨架
- `feishu-adapter.ts`：飞书卡片更新适配器
- `feishu-publisher.ts`：飞书 HTTP 发布器（鉴权 + 发消息 + 更新消息）
- `plugin.ts`：OpenClaw 插件入口（hook 接线）
- `openclaw.plugin.json`：插件清单与配置 schema

---

## 前置条件

1. 已部署可运行的 OpenClaw gateway
2. 已创建飞书应用并获取：
   - `appId`
   - `appSecret`
3. 已具备目标飞书会话投递条件（通常由插件自动路由）

---

## 安装与接入

### 1）拉取插件仓库

```bash
git clone https://github.com/cybersentia/openclaw-progress-plugin.git /opt/openclaw-progress-plugin
```

### 2）在 OpenClaw 配置中启用插件

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

### 3）重启 OpenClaw gateway

重启后，OpenClaw 会重新发现并加载插件。

---

## 配置说明

### `config.feishu`

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---:|---|---|
| `enabled` | boolean | 否 | `true` | 是否启用飞书适配器 |
| `appId` | string | 是 | - | 飞书应用 ID |
| `appSecret` | string | 是 | - | 飞书应用密钥 |
| `baseUrl` | string | 否 | `https://open.feishu.cn` | 飞书 OpenAPI 基地址 |
| `timeoutMs` | number | 否 | `10000` | HTTP 超时（毫秒） |
| `defaultConversationId` | string | 否 | 未设置 | 路由缺失时的兜底目标 |
| `stateFile` | string | 否 | `.openclaw-progress-plugin-state.json` | 路由/运行/消息绑定持久化文件 |
| `runMessageTtlMs` | number | 否 | `1800000` | 运行消息绑定持久化 TTL |

### `config.throttle`

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---:|---|---|
| `minEmitIntervalMs` | number | 否 | `1000` | 最小事件发送间隔 |
| `heartbeatIntervalMs` | number | 否 | `5000` | 心跳检查点间隔 |

---

## 路由与 receive-id 规则（重点）

插件当前支持两类飞书目标：

- `chat_id`（如 `oc_xxx`）→ 使用 `receive_id_type=chat_id`
- `open_id`（如 `ou_xxx`）→ 使用 `receive_id_type=open_id`

在 DM 场景中，canonical hook context 可能只提供 open-id 相关字段。当前实现已支持该场景，会把 `receiveIdType` 一并传递到发送链路。

### 规范化规则

当路由类型为 `open_id` 时，插件会把 `user:ou_...` 规范化为 `ou_...` 后再用于飞书 API 请求（包含恢复持久化路由和新路由绑定两条路径）。

---

## 当前 hook 覆盖范围

`plugin.ts` 当前接入了以下 typed hooks：
- `message_received`：记录 session 到会话路由
- `before_tool_call`：发送 `tool_start`
- `after_tool_call`：发送 `tool_end` 或 `failed`
- `agent_end`：发送 `completed` 或 `failed`

这套覆盖在不改 OpenClaw 核心代码前提下，已经可以提供清晰的执行感知。

---

## 飞书侧展示行为

针对一次 run：
1. 第一次事件发送一条交互卡片消息；
2. 后续事件更新同一条消息；
3. 任务结束后显示最终状态。

优点：不刷屏，用户感知连续且清晰。

---

## 故障排查

### 现象：route 缺失

常见日志：
- `skip route bind: missing conversationId in message_received`
- `skip before_tool_call/after_tool_call: route not found`

处理建议：
- 临时设置 `feishu.defaultConversationId` 保证可用性，
- 然后修复上游 canonical 映射，确保 hook 中能拿到 `conversationId`。

### 现象：Feishu invalid receive_id

常见日志：
- `code=230001 invalid receive_id`

处理建议：
- 核对 ID 类型与参数是否匹配（`oc_...` 对应 `chat_id`，`ou_...` 对应 `open_id`），
- 确认目标存在且机器人具备对应会话/用户范围权限。

### 现象：open_id 被拒绝（`99992351`）

常见日志：
- `not a valid {open_id}`
- invalid id 含 `user:ou_...`

处理建议：
- 使用已包含 open_id 规范化修复的版本，
- 如受历史状态影响，可删除旧 state 文件并重启一次。

---

## 安全建议

- 不要把 `appSecret` 硬编码进源码。
- 建议通过安全配置或密钥管理系统注入敏感信息。
- 在 OpenClaw 中通过 `plugins.allow` 明确允许的插件 ID。

---

## 变更要点

- **PR #28**：支持 DM 场景在缺失 `chat_id` 时使用 `open_id` 路由。
- **PR #29**：对持久化恢复和新绑定的 `open_id` 路由进行规范化（`user:ou_...` → `ou_...`），避免重启后再次触发飞书 invalid-open-id。

---

## 已知边界与后续增强

当前版本优先覆盖“高价值检查点”（工具阶段 + 最终态）。

如果你希望更细粒度（如 model resolve / prompt build / compaction），可继续扩展 phase 映射。

可选增强方向：
- 增加 Slack / Telegram adapter
- 更丰富的阶段时间线与耗时展示
- 多渠道路由策略（按 session/channel 区分投递）

---

## 许可证

MIT
