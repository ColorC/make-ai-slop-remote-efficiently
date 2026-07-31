# LOFA 对齐 · 实现契约速查(已核实)

> 2026-06-27 由 grounding 核实(读 normalized_protocol.py / chat.py / ccChatClient.ts / ChatMessage/ChatPanel/ToolCallCard.tsx / reviewstage/authored/projects/plans 路由)。配 plan.md。**这是契约参考,不是状态**。交付物 = `lofa/app/www/index.html` 单文件补齐,对齐电脑端真实行为,不自创。

## 0. 交付物 & 平台(铁律)
- 改的是 **`app/www/index.html`**(Capacitor 壳 + 单文件 vanilla JS)。不是后端、不是新网页、不造内容层大门面。
- 帧渲染**严格按归一化协议 kind 判别**(下表)。**绝不照 chat.py 文档里的原始 SDK 帧**(`kind:assistant/system/result` 是 SDK 原始帧,已被 ccdaemon 归一化掉;写成 `kind:assistant` 会无返回——计划点名的坑)。
- 真机/Maestro 验收需用户手机;AI 自动验收用 **Playwright 驱动真实 www 页**(对真后端 8210)+ 后端契约测试,绝不用裸 API 探针冒充 UI 验证。

## 1. WS 服务端→客户端 归一化帧(kind 判别;字段已核实)
| kind | 字段 | 渲染 |
|---|---|---|
| `stream_delta` | `content` | 累加进当前 AI 气泡,边出边显 |
| `stream_end` | — | 结束当前流式气泡 |
| `text` | `content`(完整块)| 完整 AI 文本气泡;若刚流式过则定稿 |
| `thinking` | `content` | 可折叠块,默认折叠(斜体/暗色,标题"显示推理") |
| `tool_use` | `toolId` `toolName` `input` | 建一张工具卡(status=running,标题=toolName,入参 input 折叠区) |
| `tool_result` | `toolId` `result?` `resultText?` `isError?` `exitCode?` | 按 **toolId 配对**到对应卡:状态→done/error(isError 或 exitCode≠0=error),结果折叠区(error 标红) |
| `status` | `text` `tokens?` `canInterrupt?` `tokenBudget?` | 运行指示文案(如 thinking…);`text=='token_budget'` 只更新预算条不显文案 |
| `complete` | `sessionId` `aborted?` | 本轮结束:停运行指示、复位输入;`aborted=true` 显"已中断" |
| `error` | `error` | 系统错误消息(红) |
| `permission_request` | `requestId` `toolName` `input` | v1 用 bypassPermissions,不弹权限框(可忽略) |
| `context_event` | `status` `summary` `planId` | 计划注入状态(可显小横幅) |
| `session_created` | `newSessionId` | 更新会话 id |

## 2. WS 客户端→服务端 帧
- 普通消息:`{type:"user.message", content:"...", permissionMode?:"bypassPermissions"}`
- 中断(停止按钮):`{type:"user.interrupt"}`
- 改模型(连接中):`{type:"session.model", model:"opus"|"sonnet"|null}`
- 改权限模式:`{type:"session.permission_mode", permissionMode:"..."}`

## 3. 对话 REST(都已核实存在,base `/api/cc/chat`)
- 列会话 `GET /sessions`(items[]);建 `POST /sessions {provider,cwd,effort?,model?,active_plan?}`
- provider 取值:claude_code / codex / omni_agent / kimi / opencode(后端按 provider 分发到对应 CLI)
- 历史 `GET /sessions/{sid}/history` → `{messages[],total,hasMore,tokenUsage}`(重连重建用)
- **effort** `PATCH /sessions/{sid}/metadata {effort:"low|medium|high|xhigh|max"|null}` → 回 `{effort, effort_applied?, effective:"next_user_turn"}`
- **model** 同 metadata `{model}` 或 WS `session.model`
- **改名** `PATCH /sessions/{sid}/name {name}`
- **绑 plan** `PATCH /sessions/{sid}/active_plan {plan_id}`
- **压缩** `POST /sessions/{sid}/compact`(返回新会话 meta,旧的归档)
- 删 `DELETE /sessions/{sid}`
- effort 取值:low/medium/high/xhigh/max(或 null/default);权限模式:default/acceptEdits/auto/bypassPermissions/plan
- **slash**:`/` 开头**原样作为 user.message 发**,客户端不特殊处理(claude 自解析)。v1 给快捷条(/clear /compact /help)。

## 4. 笔记 REST(都已核实)
- KB 只读:`GET /api/notes`(items[{id,title,path,size,mtime}]) · `GET /api/notes/_search?q=&limit=`(items[{id,title,snippet}]) · `GET /api/notes/{id:path}`({content,...}) · `PUT /api/notes/{id:path} {content}`(只能改已存在)
- **authored 可写**:`GET /api/boss-sight/notes`(?q=&project=&include_archived → {count,items}) · `POST /api/boss-sight/notes {content,author,target?,uses?,project_id?}` · `GET/PUT/DELETE /api/boss-sight/notes/{id}`
- v1 = 浏览 KB(只读)+ 读写 authored;v2 = poof Yjs LAN 桥(后端待补,见 UNIFIED-CONTENT-LAYER)。

## 5. 任务·项目 REST(已核实;注意 whatnow 缺口)
- `GET /api/projects`(projects[],含活动数据) · `GET /api/quests`(游戏化任务卡) · `GET /api/plans`(items[{id,topic,date,category,archived,title_zh}]) · `GET /api/projects/{id}/plans`
- ⚠ **whatnow:8230 没有经 dashboard 代理**(无 /api/whatnow、/api/tasks)。手机端任务·项目**走 /api/quests + /api/projects + /api/plans**(都存在);进度真源概念上是 whatnow,但可读端点是这三个。
- v1 只读浏览 + 状态徽标;v2 点开详情/跳关联会话审阅。

## 6. 审阅补齐 REST(已核实,base `/api/boss-sight/reviewstage`)
- 列表 `GET ?status=&tier=&plan_id=&include_archived=&pushed_only=&limit=`
- 角标 `GET /_stats` → `{total, by_status{}, by_tier{}, mandatory_unaccepted, pushed_unread}`
- 批量审判 `POST /batch_verdict {ids[],verdict,by,reason}` · 批量删 `POST /batch_delete {ids[]|null,...}`
- 单审判 `POST /{id}/verdict {verdict,by,reason}` · 评论 `POST /{id}/comment` · 归档 `POST /{id}/archive {archived,by}` · 标已读 `POST /{id}/mark_pushed`
- 正文 `GET /{id}/file`;`html`/`custom_web_template` 走 iframe(extra.live_url 同源代理优先,否则 /file);WS `/stream`(event_type=created/verdict_changed/comment_added/pushed/archived)

## 7. 里程碑顺序(痛→全)
M1 对话补完(①重连去重 ②工具卡配对 ③流式/运行中/停止 ④effort ⑤slash + 模型) → M2 笔记 v1 → M3 任务·项目只读 → M4 审阅补齐 → M5 笔记 v2 + 测试收口。
