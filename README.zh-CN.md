# OpenClaw Progress Plugin

`openclaw-progress-plugin` 是一个面向 OpenClaw 的**任务进度可视化插件**，当前以飞书（Feishu）为优先渠道。

它的目标是解决“长时间等待但不知道系统在做什么”的痛点：
- 把执行过程转换成结构化进度事件，
- 聚合为运行态状态，
- 在聊天端持续更新同一条进度卡片。

---

## 解决的问题

默认对话体验中，用户常常只能看到最终结果，看不到中间执行阶段。

该插件会把关键阶段显式展示出来，例如：
- 工具开始执行
- 工具执行完成
- 任务完成 / 失败

从而把“黑盒等待”变成“可感知进度”。

---

## 仓库结构说明

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
3. 已确认目标会话 ID（默认按 `chat_id` 发送）

---

## 安装与接入

### 1）拉取插件仓库

```bash
git clone https://github.com/cybersentia/openclaw-progress-plugin.git /opt/openclaw-progress-plugin
```

### 2）在 OpenClaw 配置中启用插件

示例配置如下（按需替换）：

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

配置说明（重点）：
- 为保证“卡片始终在当前对话展示（群聊/私聊）”，插件已固定使用飞书 `chat_id` 进行投递。
- `defaultConversationId`：**高级可选**兜底项。仅在插件暂时拿不到会话路由时使用固定会话发送卡片。
  - 常规场景建议不填，优先使用插件自动路由。
  - 若必须填写，请填写真实飞书 `chat_id`，可从飞书原始事件或网关日志中获取。

#### DM 场景快速兜底（推荐）
如果你在日志中看到：
- `skip route bind: missing conversationId in message_received`
- `skip before_tool_call/after_tool_call: route not found`

可先使用固定 `chat_id` 兜底，确保进度卡可用：

```json
{
  "plugins": {
    "entries": {
      "openclaw-progress-plugin": {
        "config": {
          "feishu": {
            "defaultConversationId": "oc_xxx"
          }
        }
      }
    }
  }
}
```

`oc_xxx` 获取方式：
- 从飞书原始事件中的 `chat_id` 获取；
- 或从网关/渠道日志中已打印的 `oc_...` 获取；
- 建议先在目标群聊或私聊发一条消息，再读取对应日志值。

注意：
- 这是**固定投递目标**，适合单会话调试或临时兜底；
- 多会话并发场景建议修复 OpenClaw 上游 canonical 映射（确保 `conversationId` 能传入 plugin hook）。

### 3）重启 OpenClaw gateway

重启后，OpenClaw 会重新发现并加载插件。

---

## 当前 hook 覆盖范围

`plugin.ts` 当前接入了以下 typed hooks：
- `message_received`：记录 session 到会话路由
- `before_tool_call`：发送 `tool_start`
- `after_tool_call`：发送 `tool_end` 或 `failed`
- `agent_end`：发送 `completed` 或 `failed`

这套覆盖在**不改 OpenClaw 核心代码**前提下，已经可以提供清晰的执行感知。

---

## 飞书侧展示行为

针对一次 run：
1. 第一次事件发送一条交互卡片消息；
2. 后续事件更新同一条消息；
3. 任务结束后显示最终状态。

优点：不刷屏，用户感知连续且清晰。

---

## 安全建议

- 不要把 `appSecret` 硬编码进源码。
- 建议通过安全配置或密钥管理系统注入敏感信息。
- 在 OpenClaw 中通过 `plugins.allow` 明确允许的插件 ID。

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
