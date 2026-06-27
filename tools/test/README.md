# LOFA 测试设施

测试是一等公民(铁律)。本目录三层验收,从纯逻辑到真机:

```
tools/test/
  web/                  # AI 可自动跑(无需手机)
    unit/               #   Vitest 单测: 归一化帧 reducer + 键控渲染 + 笔记适配层/UI 状态
    contract/           #   ajv 契约: 锁 /api/cc/chat 归一化帧 + 笔记三接口 schema
    e2e/                #   Playwright: 驱动真实 app/www 页, mock WS/REST 跑对话/笔记全流程
    serve.mjs           #   静态服务器(给 e2e 托管 app/www)
  maestro/              # 真机/模拟器主路径(手机验收, 留录像作审阅物料)
    chat-flow.yaml      #   M1 对话
    notes-flow.yaml     #   M2 笔记(写 authored → PC 侧可见 闭环)
    projects-flow.yaml  #   M3 项目/任务/计划(只读, 状态徽标 vs PC 看板同源)
    review-flow.yaml    #   M4 审阅(审判/批注/批量 → PC 审阅台同后端一致 闭环)
```

## Web 测试(单测 + 契约 + 端到端)

```bash
cd tools/test/web
npm install                 # 一次
npm test                    # Vitest: unit + contract (242 用例)
npm run e2e:install         # 一次, 下 chromium
npm run e2e                 # Playwright: 15 个流程用例(对话 6 + 笔记 2 + 项目 2 + 审阅 5, 对真实页面)
PWVIDEO=on npm run e2e      # 同上, 并录全部用例视频(留作审阅物料)
```

覆盖(对齐 plan 的 5 个对话痛点 + 电脑端能力):
- **reducer**(`unit/normalizedChat.test.js`): snapshot 清空重建、重连去重(幂等)、stream_delta 合并、
  thinking、tool_use/tool_result 按 toolId 配对、error/complete 状态复位、status/token_budget。
- **renderer**(`unit/chatRender.test.js`, jsdom): 键控复用(流式只改文本不重建 DOM)、工具卡名/入参/结果折叠、
  error 标红、snapshot 重建清旧节点。
- **契约**(`contract/`): 代表性归一化帧过 schema、原始 SDK 帧(`kind:assistant/system/result`)被拒、
  metadata `{effort, effort_applied, model, effective}` 结构锁定;并双向锁(schema 认的帧 reducer 必能消费)。
- **e2e**(`e2e/chat.spec.js`): 发消息→运行中→流式追加→complete;停止发 `user.interrupt`→已中断;
  断连重连 snapshot 不翻倍;effort 选择器 PATCH metadata;slash 原样发;工具卡 toolId 配对。

### 笔记(M2)

- **适配层**(`unit/notesState.test.js`): KB 永远只读、搜索走 `_search` 端点、来源过滤(kb/authored/all)、
  卡片归一(KB/authored)、create/update payload(content 必填、update 始终带 `by`)。
- **UI 状态**(`unit/notesView.test.js`, jsdom): KB 卡片/详情明确只读(无编辑按钮)、搜索命中 `_search`、
  接口失败显可重试错误卡且重试后恢复、写札记/编辑/归档发出正确 payload 并刷新列表、markdown 渲染。
- **契约**(`contract/notes.contract.test.js`): 锁 `/api/notes`、`/api/notes/_search`、
  `/api/boss-sight/notes` 的列表项/详情/读写 schema(对齐 notes.py / authored/store.py),并双向锁(适配层能消费)。
- **e2e**(`e2e/notes.spec.js`): 进 Notes→浏览 KB→搜索→打开 markdown 只读详情;切「我的札记」→写一条→
  保存后列表可见→打开编辑保存→列表更新(有状态 mock store)。录像 `docs/lofa-m2-notes-e2e.webm`。

### 项目(M3)

- **适配层/UI**(`unit/projectsState.test.js` + `unit/projectsView.test.js`, jsdom): 三页签端点选择、
  状态徽标映射、卡片归一、只读详情、失败可重试、**只读护栏(全程零写请求)**。
- **契约**(`contract/projects.contract.test.js`): 锁 `/api/projects`、`/api/quests`、`/api/plans`、
  `/api/projects/{id}/plans`、`/api/plans/{id}` 关键字段, 并双向锁。
- **e2e**(`e2e/projects.spec.js`): 项目列表→切任务卡→筛选→打开任务/计划详情, 徽标与 fixture 一致。

### 审阅(M4)

- **适配层**(`unit/reviewState.test.js`): 多选 reducer、批量/单条审判·评论·删除 payload、`include_archived`
  查询、`_stats` 角标映射、图片归一化坐标→屏幕坐标、markdown 行号定位、`custom_web_template` 兜底、批注分桶、
  WS `/stream` 事件判别。
- **UI 状态**(`unit/reviewView.test.js`, jsdom): `_stats` 角标渲染、多选→批量审判/删除发正确 payload + 二次确认、
  `include_archived` 切换改请求、6 类 material 各渲染、审判/评论 payload、`mark_pushed`、WS 回流刷新详情与列表。
- **契约**(`contract/review.contract.test.js`): 锁列表项 / `_stats` / material(含 `custom_web_template` 与批注 anchor)
  / `batch_verdict`·`batch_delete`·`comment` 请求体 / WS `/stream` 事件 schema, 并双向锁。
- **e2e**(`e2e/review.spec.js`): 列表+角标→6 类 material 各渲染;审判→评论→WS 回流刷新详情;
  `include_archived` 切换;多选→批量审判;多选→批量删除。录像 `docs/lofa-m4-review-e2e.webm`。

## Maestro 真机主路径

```bash
maestro test tools/test/maestro/chat-flow.yaml     # M1 对话
maestro test tools/test/maestro/notes-flow.yaml    # M2 笔记
maestro test tools/test/maestro/projects-flow.yaml # M3 项目(只读)
maestro test tools/test/maestro/review-flow.yaml   # M4 审阅
# 或 maestro studio 录屏, 把录像存到 docs/ 作本任务审阅物料
```

需手机已装 LOFA 并连上本机 omnicompany。
- 对话: 进会话→新建→发消息(运行+流式)→工具卡→中途停止→返回重进(历史不乱不重)→切 effort→发 `/clear`。
- 笔记: 进笔记→浏览 KB(只读)→搜索→打开 markdown 详情→切「我的札记」→写一条 authored→保存可见→
  编辑保存→列表更新;闭环: 手机写的札记应能在 PC 看板或 `/api/boss-sight/notes?q=` 读到。
- 项目: 进项目→项目/任务/计划三页签→状态筛选→打开只读详情;闭环: 徽标与 PC 项目工作板同数据源一致。
- 审阅: 进审阅→列表+角标→详情(6 类 material)→审判→批注→看 WS 回流刷新→多选批量审判;
  闭环: 手机审判/批注后, PC 审阅台(`/api/boss-sight/reviewstage`)应见同一材料状态/评论变化。
