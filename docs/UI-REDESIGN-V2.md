# LOFA 界面重做 v2 · 设计规格(权威)

计划锚点:`remote-client/[2026-06-27]LOFA-DESKTOP-PARITY` M12 二期。
**本文取代 `UI-REDESIGN.md`(v1 已废,只留档)**。进度不在此(进度看 whatnow)。

用户判决(2026-07-16):v1 改造仍不合格——CLI 界面和对话界面各自为战,CLI 是 iframe 借桌面页
「非常抽象和难看,大幅被无用内容占据」;新建会话(三个大按钮+弹窗问路径)和切换会话都很差。
要求:**按成熟 app(AI 对话/终端/笔记知识库/开发类)100% 对齐,完完全全前端重做**,
只保留相对深色的液态玻璃气质(背景还要更适合表现液态玻璃),交互跳转与整体排布必须和现在完全不同。

---

## 0. 铁律(继承 + 新增)

1. 改的是 `lofa/app/www/`,不改后端业务。所有后端契约以 §2 为准(已重新核实源码)。
2. 帧渲染严格按归一化协议 kind 判别;绝不认 SDK 原始帧。
3. 纯 vanilla ES modules,**无构建步骤**(Capacitor WebView 原生支持;cap copy 直接拷 www)。
4. 数据层资产**保留**:`normalizedChat.js`(reducer,纯函数)、`ws.js`(重连封装)、
   `reviewState.js` / `projectsState.js`(纯逻辑)、`remote.js`(B 档轮询;其 `navigate` op
   引用旧 tab id 已坏,重做时改接新导航 API)。`core.js` 的连接/API/LOG/NOTIF/OTA 逻辑保留但重组。
5. **CLI 终端不再 iframe**:app 内自渲染 xterm(`vendor/xterm.js` + `addon-fit.js` 已 vendor),
   消费 PTY WS。`/chatui/cli` iframe 路线废弃。
6. 视觉只保留「深色液态玻璃」这一个基因,其余全部重来。
7. 界面永不堆说明文字;游戏内文本规范不适用,但 UI 文案要完整词、通用词。
8. AI 自动验收 = Playwright 驱动真实 www 页 + vitest 单元/契约;真机观感由用户裁决。

## 1. 现状资产盘点(重做时的处置)

| 现文件 | 处置 |
|---|---|
| `index.html`(596 行,含全部 CSS) | **重写**。CSS 拆出到 `css/*.css`,html 只留骨架 |
| `js/app.js` | **重写**(壳+路由+接线) |
| `js/core.js` | **重组**:连接/api/LOG/NOTIF/OTA/字号保留,`showView` 视图机制换掉 |
| `js/ui.js` | **扩建**:sheet 保留思想重写,新增组件套件 |
| `js/chatView.js` | **重写**(会话列表并入统一会话空间,对话屏重做) |
| `js/chatRender.js` | **重写**(markdown 渲染、新工具卡形态;键控复用思想保留) |
| `js/normalizedChat.js` `js/ws.js` | **原样保留**(契约测试盯着) |
| `js/reviewView.js` `js/projectsView.js` `js/notesView.js` | **重写渲染层**,复用各自 state 模块 |
| `js/reviewState.js` `js/projectsState.js` `js/remote.js` | 保留(remote.navigate 改接新导航) |
| `vendor/xterm*` | **启用**(此前从未 import) |

## 2. 后端契约(2026-07-16 重新核实源码,以此为准)

### 2a. chat 会话(`/api/cc/chat`,经 dashboard 反代 ccdaemon:8201)
- 列 `GET /sessions` → `{items:[to_meta]}`;meta 字段:`id, kind="chat", provider, name, archived,
  favorite, cwd, started_at, alive, running, subscribers, claude_session_id, active_plan, goal_state,
  caller_identity, adopted, taken_over, model, permission_mode, effort, ended_at, exit_reason, status`
- 建 `POST /sessions {provider, cwd, effort?, model?, active_plan?}`
- 历史 `GET /sessions/{sid}/history`;effort/model `PATCH /sessions/{sid}/metadata`
  (`effort_applied` 是字符串:reconnected/unchanged=即时,其余下轮);改名 `PATCH /name`(空名 400);
  绑计划 `PATCH /active_plan {plan_id}`;压缩 `POST /compact`(返回新会话 meta);删 `DELETE /sessions/{sid}`
- 四态徽标 `GET /api/cc/chat/active`(2026-07-16 核实源码):响应
  `{count, window_sec, items:[{session_id, provider, mtime, status, last_did, last_user, digest?}]}`,
  status=working/done/waiting/idle;⚠ `session_id` 是 **transcript 的 claude_session_id**,
  与 chat 会话配对必须用 `meta.claude_session_id`(不是 chat 的 `id`)
- 归档(2026-07-16 核实):`PATCH /sessions/{sid}/metadata {archived:true}`
  (PatchSessionMetadataBody 含 archived/favorite/model/permission_mode/effort)
- WS `/api/cc/chat/sessions/{sid}/ws`,归一化帧 15 kind(见 `normalizedChat.js` 头注释,以 reducer 为准)
- 客户端帧:`user.message`(content, permissionMode)/`user.interrupt`/`session.model`/`session.permission_mode`
- provider 差异:claude_code effort=low..max 且中断即时;codex effort=minimal..high 且中断=轮次取消;
  omni_agent **无 effort**(置灰);kimi/opencode 前端暂照 codex 最小形态给选项
  (model:kimi=default/kimi-for-coding、opencode=default;effort=default/minimal..high)
- slash 命令 `/` 开头原样发,前端不解析

### 2b. PTY 终端会话(`/api/cc`,`pty_routes.py`;**wire 以下述为准,契约速查文档的速记不准**)
- 列 `GET /sessions?include_recoverable=true` → `{items:[...], alive_count, recoverable:[...], recoverable_count}`
  meta:`id, cmd, cwd, cols?, rows?, alive, safe_mode?, last_output_at, claude_session_id, active_plan?, status`
- 建 `POST /sessions {cmd?: string[], cwd?, cols, rows, safe_mode}`;`cmd=null` 默认 claude CLI,
  **可传任意命令**(如 `["powershell"]` 开纯 shell)
- 续接 `POST /sessions/{recoverable_id}/resume`(`claude --resume`,返回新 meta 带 `resumed_from`)
- 杀 `DELETE /sessions/{sid}`;上下文 `GET /sessions/{sid}/context`;绑计划 `PATCH /active_plan`
- WS `/api/cc/sessions/{sid}/ws`:
  - 服→客:`{type:"snapshot", chunks:[str]}`(attach 即发,重画屏)/`{type:"output", data:str}`/`{type:"exit", reason}`
  - 客→服:`{type:"input", data:str}` / `{type:"resize", cols, rows}`
  - 30min 无订阅+无输出回收;WS 断开自动重连后靠 snapshot 重建
- 装 provider `GET/POST/DELETE /install`(provider=claude_code|codex)

### 2c. 其余(沿用 v1 已核实契约)
审阅 `/api/boss-sight/reviewstage/*`(+WS /stream);项目 `/api/projects|quests|plans`;
笔记 iframe `{base}/lofa/poof/app/notes-web.html`(待迁 `/lofa/overlay/*`);
代码面板 iframe 由 `/lofa-config.json` 下发;OTA `/api/android/apk/*`;B 档 `/api/android/commands/*`。

## 3. 设计依据(五路调研定稿结论)

2026-07-16 五路并行调研(AI 对话 app:Claude/ChatGPT/Perplexity/Gemini;移动终端:Termius/Blink/
Termux/JuiceSSH/Prompt3;笔记知识库:Notion/Readwise Reader/Bear/Obsidian;AI+终端融合:Warp/
Replit/Cursor/GitHub Mobile/VS Code;液态玻璃:iOS 26 HIG/WWDC26/移动 WebView 性能实证)+ 完备性
批评 12 条。核心定论:

1. **新建必须零配置直达**:成熟 app 没有一家让用户先过「选类型弹窗+填路径弹窗」才能开始。
   唯一新建入口 + 默认沿用上次配置 + 配置项后置为可点 pill。
2. **列表是一级页面,sheet 只做临时选择**:承载完整可滚动列表(会话历史)必须是带大标题的页面,
   不是弹层。快速切换(临时挑一个跳过去)可以用 sheet。
3. **玻璃只属于导航/功能层**(顶栏/底 tab/浮层/按钮),**内容层(正文/列表/消息/终端输出)永远实底**;
   同屏玻璃层数 ≤2;玻璃绝不挂在滚动容器上;移动端 blur ≤12px;背景必须有可折射的色斑层。
4. **工具调用=活动卡片**:运行中显示动词状态,完成自动折叠成单行摘要,点开才展开详情——这是把
   「命令执行」融进对话流的关键形态(Warp 块思想在前端能落的部分)。
5. **终端的正统做法**:附加键条(Termux 式 2 行,Esc/Tab/Ctrl/Alt/方向/常用符号,Ctrl 粘滞,长按二级)、
   双指捏合调字号、snapshot 重连重画、状态色点、键盘弹起实时 resize。
6. **列表行黄金结构**:左图标(状态叠加)+双行文字(标题+元数据)+右侧状态,行高 64-80px,时间桶分组
   sticky 小标题;长按菜单+可见三点兜底;批量=「选择」按钮+底部操作条。
7. **返回手势栈优先级**:软键盘 → sheet/menu/modal → 详情页 pop → tab 根页 → 最小化;
   系统边缘返回手势区不被自定义手势占用。
8. **动效**:进场 cubic-bezier(0.32,0.72,0,1) 300-380ms,退场 ease-in 200-260ms 更快;菜单从锚点
   scale .92→1 带轻回弹;blur/saturate 数值本身绝不参与过渡动画。

## 4. 新信息架构(IA)

### 4a. 底部 4 tab(常驻玻璃条,替代现有 5-tab+首页宫格+全局顶栏)

| tab | 内容 | 说明 |
|---|---|---|
| **会话**(默认) | 统一会话空间:chat 会话 + PTY 终端会话混排一个时间轴 | 本轮旗舰 |
| **审阅** | 审阅收件箱(未读 badge 数字角标) | reviewState 保留 |
| **项目** | 项目/任务/计划只读板 | projectsState 保留 |
| **我的** | 连接·外观·终端·代码面板·笔记入口·关于/OTA | 设置分组列表 |

- 现全局顶栏 `#bar`(LOFA·刷新·设置)**删除**。每个 tab 页自带大标题头;刷新靠数据自动加载+各页
  下拉已弃(调研:成熟 AI app 无下拉刷新,靠实时连接),提供每页头部一个轻量刷新按钮仅在审阅/项目页。
- **笔记降为「我的」里的入口**(iframe 全屏打开,同代码面板),不占 tab——它是 iframe 借的 poof,
  不是本 app 的原生高频面;省出的 tab 位让「我的」有正式位置(连接/字号/终端设置都是真实高频)。
- 新建**不占 tab**:会话页右下 FAB(+)。
- 底 tab 在:4 个 tab 根页显示;所有推入页(对话/终端/详情/全屏 iframe)隐藏。

### 4b. 视图栈(router.js)

- `router.tab(name)`:切 tab(根页间切换,无转场或 120ms 淡入)。
- `router.push(viewId)` / `router.pop()`:推入/弹出(对话屏/终端屏/审阅详情/项目详情/iframe 全屏)。
  转场:push 右滑入 300ms `cubic-bezier(0.32,0.72,0,1)`,pop 反向 220ms ease-in;
  `prefers-reduced-motion` 时全部瞬切。
- Android 硬件返回优先级(app.js 接线,router 提供 `router.back()` 统一入口):
  收软键盘(若开)→ 关最上层浮层(sheet/menu/modal,`ui.closeTopLayer()`)→ pop 推入页 →
  非会话 tab 则回会话 tab → 会话 tab 根页则 `minimizeApp()`。
- 深链预留:`router.open('session:<id>')` / `router.open('review:<id>')`(remote.js navigate op 与
  通知点击共用;本轮实现 session/review 两种)。

## 5. 视觉系统(液态玻璃 v2)· css/tokens.css 唯一真源

### 5a. 背景(玻璃的承托层)

- `body` 底色 `--bg: #0a0d14`(近黑非纯黑)。
- `#ambient`(fixed 全屏 z-0,app 启动即在,永不重绘):3 个大 radial 色斑
  (蓝 `rgba(76,141,255,.13)` 左上 / 青 `rgba(56,189,248,.09)` 右下 / 紫 `rgba(139,92,246,.08)` 右上外沿,
  半径 45-60vmax)+ 一层 SVG feTurbulence 噪点(data URI,`opacity:.035`,`mix-blend-mode:overlay`)。
- 色斑极慢漂移动画(90s ease-in-out 交替,只动 transform),`prefers-reduced-motion` 或
  「减少透明度」开启时静止。
- 所有页面容器背景透明,让 ambient 透出来——玻璃条下面才有真东西可折射。

### 5b. 玻璃两档(只用于导航/功能层)

```css
--glass-nav-fill: rgba(22,28,40,.58);   /* 常驻:顶栏/底tab/composer 外壳/附加键条 */
--glass-nav-blur: blur(10px) saturate(180%);
--glass-sheet-fill: rgba(28,34,48,.72); /* 浮层:sheet/menu/modal(更厚) */
--glass-sheet-blur: blur(14px) saturate(180%);
--glass-edge: inset 0 1px 0 rgba(255,255,255,.10);       /* 顶边高光,只加顶边 */
--shadow-nav: 0 8px 24px rgba(0,0,0,.35);
--shadow-sheet: 0 -12px 48px rgba(0,0,0,.5);
--scrim: rgba(0,0,0,.5);
```

硬规则:同屏玻璃 ≤2 层(顶栏+底 tab;sheet 弹出时 scrim 盖住其余,仍 ≤2);玻璃绝不挂在
可滚动容器;全部双写 `-webkit-backdrop-filter`;「减少透明度」设置(我的→外观,存
`lofa.reduceGlass`,同时尊重 `prefers-reduced-transparency`)开启时 html 加 `.no-glass`,
所有玻璃变量整体替换为同色实底并去 blur。

### 5c. 内容层(永远实底)

```css
--surface: #141a26;        /* 卡片/列表行/消息气泡底 */
--surface-2: #1a2130;      /* 卡片内嵌块/hover 亮一档 */
--surface-input: #0e1420;  /* 输入框/终端底 */
--line: rgba(255,255,255,.08);
--fg: #f0f4fa;  --fg-2: #a9b4c6;  --fg-3: #6b7890;
--accent: #5b9dff;  --ok: #34d399;  --busy: #f5b942;  --bad: #f4726d;
--provider-claude: #e08a5f; --provider-codex: #a78bfa; --provider-omni: #38bdf8; --provider-term: #4ade80;
```

### 5d. 圆角/字阶/间距/动效

- 圆角:`--r-pill: 999px`(chip/按钮/状态点)/ `--r-card: 16px`(行/卡/气泡)/ `--r-sheet: 24px`(sheet 顶两角)/
  `--r-input: 22px`(composer 胶囊)。支持处渐进 `corner-shape: squircle`,不做 clip-path。
- 字阶(`--font-scale` 只乘正文类):大标题 28px/750;页内标题 17px/650;正文 15px;次要 13px;
  说明 12px;等宽 `ui-monospace,'Cascadia Mono',Consolas`,消息正文 `calc(15px*var(--font-scale))`。
- 触控:所有可点最小热区 44×44(视觉可更小,padding 补);图标按钮统一 40×40 圆形。
- 动效 token:`--ease-out: cubic-bezier(0.32,0.72,0,1)` / `--ease-in: cubic-bezier(0.4,0,1,1)` /
  `--ease-spring: cubic-bezier(0.34,1.56,0.64,1)`;`--t-push: 300ms` `--t-pop: 220ms` `--t-sheet: 320ms`
  `--t-menu: 180ms` `--t-fast: 120ms`。
- safe-area:顶栏 `padding-top: env(safe-area-inset-top)`;底 tab/composer/附加键条
  `padding-bottom: max(8px, env(safe-area-inset-bottom))`。

## 6. 组件套件(js/ui.js + css/components.css)

全部纯 vanilla,导出函数式 API;每个组件语义 class 前缀 `lg-`(liquid glass)。

1. `openSheet({title?, rows, onClose?}) → {close, el}`:底部 sheet(v1 思想保留,视觉升级:
   sheet 玻璃厚档、拖拽手柄全区域下滑可关、进出场用 --t-sheet/--ease-out)。行类型同 v1
   (header/row/action/divider/item/empty)+ 新增 `radio`(右侧单选点,点选即生效自动收起——
   模型/effort 选择器用,**替代 pickModal 两段跳**)。
2. `openMenu({anchor, items}) → {close}`:锚点上下文菜单(长按/三点用;items=[{icon,label,danger?,onTap}]),
   从锚点 scale .92→1 弹出,点外关闭。**替代一部分 sheet 滥用**。
3. `openModal({title, body?, input?, textarea?, okText, danger?, onOk})`:确认/输入弹窗(保留自建,
   视觉升级);`promptModal/confirmModal/pickModal` 旧 API 在 core 里桥接到新实现,pickModal 内部改走
   radio sheet。
4. `toast(msg, {type?})`:底部胶囊 toast(ok/err 变体)。
5. `fab({icon, onTap})`:右下浮动按钮(56×56,accent 实底,底 tab 上方 16px)。
6. `swipeRow(el, {actions})`:列表行左滑露出操作(归档/删除)——**Android 上以长按菜单为主,
   左滑为增强**;实现为可选绑定。
7. `segmented(el, {options, value, onChange})`:分段控件(项目板三页签/字号档)。
8. `listRow(...)` 移动端行构造器:`{icon, iconClass, title, sub, metaRight, statusDot?}` → 行 DOM
   (统一 64-76px 行高、双行截断)。
9. `emptyState({icon, title, hint?, action?})`:空态(图标+一句话+一个可选动作按钮)。
10. `banner`:全局连接状态条(顶栏下,红「连接已断开·重连中…」/绿一闪「已连接」2s 消失;
    由 core 连接健康驱动,任何 tab 可见)。
11. `largeHeader(view, {title, searchable?, actions?})`:页头骨架——大标题一行,滚动内容时收缩为
    17px 紧凑顶栏(CSS sticky + IntersectionObserver 哨兵,不逐帧 JS);可选搜索框吸附在标题下。

层管理:`ui.layers` 栈(sheet/menu/modal 入栈),`ui.closeTopLayer()` 给返回键用;scrim 点击=关;
全部浮层 z-index 用 token(`--z-nav:100 --z-fab:110 --z-banner:120 --z-layer:200 --z-toast:300`)。

## 7. 逐屏规格

### 7a. 会话 tab 根页 `#sessionsView`(统一会话空间)

- 大标题「会话」+ 搜索框(过滤标题/cwd,前端过滤)。
- 数据:并拉 `GET /api/cc/chat/sessions`(kind=chat 未归档)+ `GET /api/cc/sessions?include_recoverable=true`
  + `GET /api/cc/chat/active`(四态);8s 轮询合并(替代旧 5s overview timer)。
- 归一为统一行模型 `{id, kind:'chat'|'term', title, provider, cwd, status:'running'|'waiting'|'ended'|'recoverable',
  lastActive, meta}`(纯函数进 `sessionsState.js`,可单测):chat 的 running/alive + active 四态 →
  running/waiting/ended;PTY 看后端 `working` 信号(近 8s 有输出,TUI 回合结束即翻 false)→running/waiting,
  recoverable→recoverable。
- 分组(sticky 小标题):一律按 lastActive 时间桶(**「今天」**/「昨天」/「本周」/「更早」),
  不再单设「进行中」置顶组(2026-07-18 修订)——running 行的 lastActive 天然最新,自动排在今天组最前,
  状态交给行内徽标(spinner/待输入)表达。
- **行标题可读化**(2026-07-16 修订):后端默认机器名(「Provider · 工作区 · 日期」三段式)不当标题。
  标题优先级 = 用户改过的名 > `/active` digest 一句话中文主题 > 最后一条用户输入摘录(36 字) >
  机器名剥掉相同前缀(留「工作区 · 日期」)> provider 兜底;纯函数 `chatTitle` 在 sessionsState,
  有单测锁行为。
- 行(listRow):左 40px 图标——chat=对话气泡形,term=终端方框形,染 provider 色,右下角叠 10px 状态点
  (running=busy 琥珀+呼吸动画 / waiting=ok 绿 / ended=灰 / recoverable=空心灰);标题一行;
  副行 `provider 名 · cwd 尾段 · 相对时间`;右侧:running 显 12px spinner,waiting 显「待输入」微标。
- 点击:chat 行→`router.push(chatView)`;term 行 alive→`router.push(termView)`;recoverable→确认弹窗
  「续接此会话?」→ `POST /resume` → 进终端。
- 长按或行尾三点→openMenu:改名·绑定计划·压缩(仅 chat)·归档(chat)/杀死(term,danger)·删除(danger,
  二次确认)。
- FAB(+)→ **新建 sheet**(见 7b)。
- 空态:「还没有会话」+「新建」按钮。

### 7b. 新建会话 sheet(零配置直达)

- 首行大按钮:「⚡ 继续上次配置新建」——副文案显示上次 `provider · cwd 尾段`(存 `lofa.lastNewSession`),
  一击直达(建完直接 push 进对应屏)。首次无记忆时此行隐藏。
- 分区「类型」:10 个 radio 行,两组——对话:Claude 对话 / Codex 对话 / Omni 对话 / Kimi 对话 /
  OpenCode 对话;终端:Claude CLI / Codex CLI / Kimi CLI / OpenCode CLI / PowerShell
  (cmd 分别为 null(默认 claude)/`["codex"]`/`["kimi"]`/`["opencode"]`/`["powershell"]`;
  终端组建的是 PTY 会话)。默认选中上次类型。
- 分区「工作目录」:最近目录 chips(从两族会话 meta 聚合 cwd 去重取 6 个,横滑)+「自定义…」
  (openModal 输入);默认选上次。
- 底部主按钮「新建」:POST 对应族接口 → 存 lastNewSession → close → push 进屏。
- 无任何必填弹窗;整个流程最快 1 击(继续上次),常规 2-3 击。

### 7c. 对话屏 `#chatView`(推入页)

- 顶栏(玻璃 nav 档,44px+safe-area):返回 ‹;中间两行——标题(会话名,单行截断,**不可点改名**)+
  副行 pill「provider · model · effort」(**点 pill 弹会话设置 sheet**);右侧:运行中会话指示器
  (仅当其它会话有 running 时显示:琥珀点+数字,点开快速切换 sheet:列出其它会话行,点即切)+ 三点
  (openMenu:改名/绑定计划/压缩上下文/查看注入上下文/归档)。
- 会话设置 sheet(点 pill):radio 行选模型(provider 相应选项+「自定义…」)、radio 行选 effort
  (provider 差异化档位;omni_agent 该行 disabled 显「不支持」);即选即生效自动收起(PATCH metadata,
  toast 报生效时机)。
- 消息流 `#chatMsgs`(滚动容器,实底透明让 ambient 透出、消息卡实底):
  - user:右对齐 accent 实底气泡(max 84%)。
  - assistant:左侧无边气泡(surface 实底卡),**mdToHtml 渲染 markdown**(代码块等宽+横滚),
    流式尾部光标闪烁;流式中只 append 文本节点(键控复用保留)。
  - thinking:一行「▸ 思考过程」折叠条(fg-3 斜体),点开展开。
  - **工具活动卡片**(核心重做):单行摘要形态——左状态图标(运行中=spinner/成功=✓绿/失败=✗红)+
    toolName 等宽 + 一段入参摘要(取 input 里最有信息量字段:command/file_path/pattern/url…截断)+
    右侧时长;运行中卡片带微呼吸底色;**完成后保持单行折叠**,点行展开:入参块+结果块
    (等宽 12px,max-height 40vh 内滚,error 红字;超长结果尾部截断+「复制全部」)。
    连续 ≥3 张已完成工具卡自动聚拢为「N 个步骤 ▸」一行(点开展开该组)——防长任务刷屏。
  - system:居中小字(error 红/info 灰);「已中断」温和灰。
  - context 注入:不进流;toast 一次 + composer 左「+」菜单里「已注入上下文 N」入口。
- 运行指示:composer 上方一条细行(spinner+status 文案+token 预算小字),运行时显示。
- composer(玻璃 nav 档外壳,内部输入框实底胶囊):左「+」圆钮(openMenu:查看注入上下文/
  复制会话 id/滚到底部;为附件留位);中 textarea 自增高(1→6 行,内滚);右**单按钮三态**:
  空=灰禁用箭头 / 有字=accent 实心↑发送 / running=红方块停止(user.interrupt),形变 120ms。
  Enter 发送(shift 换行),斜杠补全浮层保留(玻璃厚档,键盘导航同 v1)。
- 键盘弹起:`visualViewport` 监听,消息流 scrollToBottom 保持;顶栏保持(不再隐藏副信息——顶栏本来就瘦)。
- 断线:全局 banner 显示「重连中」;snapshot 重放清空重建(reducer 现成)。

### 7d. 终端屏 `#termView`(推入页,全新)

- 顶栏同骨架:返回 ‹;标题两行——会话名(cmd[0] 或「终端」)+ 副行 `cwd 尾段 · 状态文字`;
  状态色点(连接中=琥珀呼吸/已连接=绿/断线=红/已退出=灰);右侧三点(openMenu:改名(本地展示名,
  存 localStorage)/绑定计划/复制会话 id/**杀死会话**(danger,DELETE))。
- 终端区(2026-07-16 二次修订:参照系=「把 Claude Code/Codex CLI 渲染得最好的终端」的机制,
  不是复刻某终端外观):
  - **xterm 6.0.0 全家桶**(fit 0.11/webgl 0.19/unicode-graphemes 0.4,同日配套版本禁混搭,
    台账 `vendor/VENDOR.md`)。6.0 核心内建 **DEC 2026 同步输出**——Ink≥6.7 的 Claude Code
    每帧发 CSI?2026h/l,这是零闪烁的机制根源;5.5 会忽略该序列。
  - **`windowsPty:{backend:'conpty', buildNumber:19045}` 必设**:后端是 pywinpty/ConPTY,
    不设则 xterm 按 Unix pty 换行语义猜 reflow(Windows 排版错乱根源类;VS Code 同款,
    build<21376 自动禁 reflow 是正确行为)。
  - **minimumContrastRatio: 4.5**(VS Code 的可读性来自它自己设 4.5,xterm 默认 1 不干预)。
  - **宽度表 grapheme 群集**:UnicodeGraphemesAddon,`unicode.activeVersion='15-graphemes'`
    (emoji ZWJ/组合记号整簇算宽),失效退 unicode11 '11'。
  - 字体内嵌 **Cascadia Mono woff2**(OFL;font-display:block + `document.fonts.load` 就绪
    后才建 term——swap 会量错格宽永久错位);fontFamily 两段式 `'Cascadia Mono', monospace`
    (链里混比例字体会破坏等宽格栅;CJK 落 generic 是预期回退)。**禁 ligatures addon**
    (连字会破坏框线格栅)。
  - webgl onContextLoss→dispose 退 DOM(Android WebView 回收 GL 上下文远比桌面激进)。
  - 后端 spawn 环境默认带 **CLAUDE_CODE_FORCE_SYNC_OUTPUT=1**(pty.py;WebView+ConPTY 两跳
    链路上 2026 自动探测不可靠,官方点名此场景显式强开;下次 ccdaemon 重启生效)。
  - 配色三选一存 `lofa.termTheme`(PowerShell 蓝默认/Campbell 深黑/跟随应用);cursorStyle bar、
    scrollback 9001、rescaleOverlappingGlyphs;fontSize 默认 13(`lofa.termFontSize`);
    容器实底。调试句柄 `window.__lofaTerm`(WebGL 下 DOM 无文本,查屏走 buffer)。
  - 遗留观察项:ConPTY 有不可恢复的画面损坏类故障(Claude Code #14599),前端只能整体重连兜底;
    Codex CLI 个别版本在 ConPTY 有闪烁回归,升级 codex 时留意。
- WS 接线(`openReconnectingWs` 复用):onFrame 按 `{type}` 分发——snapshot→`term.reset()`+顺写 chunks;
  output→`term.write(data)`;exit→显示终端上覆盖层「会话已结束(reason)」+「回列表」按钮;
  onReconnecting→banner;`term.onData→{type:'input',data}`;resize(fit 后 cols/rows 变化)→
  `{type:'resize',cols,rows}`(300ms debounce)。
- **附加键条**(玻璃 nav 档;termKeys.js 纯逻辑;**默认隐藏**——软键盘弹起(visualViewport kb>60)
  或顶栏 ⌨ 手动钉住才出现,不常驻占屏)。**2026-08-18 三次修订**(实机不可用三连:挡输入行 /
  点击穿透弹输入法 / 拼不出 Alt+回车),定位与交互全部重订:
  - **位置=终端上方,紧贴顶栏**(不再在屏底)。理由是机制性的:键条在下方时,`--kb` 键盘 inset
    与 WebView 自身 resize 只要有一点重复或欠算,被吃掉的就是最后一行——而最后一行正是 CLI 的
    输入行,是打字时唯一要看的东西。移到上方后「输入行 = 键盘上沿之上那一行」与键条显隐解耦。
  - **终端区内不允许常驻悬浮件**。原右下角 ⌨ 浮钮(`.term-kfab`)已删除——它 44×44 常压在
    输入框右端;开关移入顶栏 `lg-icon-btn`(`data-t="kbtoggle"`,`aria-pressed`)。仅保留
    `.term-latest`(↓ 最新),它只在滚离底部时出现,滚到底即消失,不与输入行同时在场。
  - **⌨ 只开关键条,不 focus 终端**。要输入法就点终端本身。旧实现里每颗键按完都
    `term.focus()`,在 Android 上等于「按 Esc 顺带弹出输入法」。键条自己发
    `{type:'input'}` 上行,与 xterm 焦点无关,那次 focus 纯属副作用。钉住是显式意图,
    不再因键盘收起被悄悄清掉(要收再点一次 ⌨)。
  - **事件模型 = 单一 Pointer Events 路径,`pointerdown` 一律 `preventDefault()`**
    (键条容器与每颗键都拦,连键与键之间的缝隙也拦)。这同时解决两件事:焦点不离开当前元素
    → 不弹输入法;浏览器不补发兼容 `mousedown/mouseup/click` → 不存在「这一下又落到终端上」的
    穿透。旧的 touch/mouse 双路径 + `recentTouch()` 时间窗兜底已删除。
  - **长按浮泡挂在铺满屏的 `.term-hold-scrim` 上**,泡外那一下由 scrim 吞掉只用来收泡——
    旧实现把泡挂在 `document.body`、泡外的点击直接落到 `.term-screen`,正是穿透弹输入法的第二个源。
    键条在顶部后浮泡空间不足会自动翻到键的下方(`.term-hold.below`)。
  - 2 行 × **8 键**(顶栏接管 ⌨ 后腾出的 44px 用来补键;以 spec 为准的固定键位,不做自定义拖拽):
    - `Esc  Tab  /  |  ~  ↑  Home  PgUp`
    - `Ctrl  Alt  ^C  换行  ←  ↓  →  End`
  - **新增三键补齐移动端拼不出的组合**:
    - `换行` = **ESC CR(`\x1b\r`)**,即 Alt/Option+Enter 的线上表示。Claude Code / Codex CLI
      等 Ink 系 TUI 读作「插入换行而不提交」;软键盘的回车只能提交,这是移动端唯一稳定可达的
      多行输入手段。长按出二级 `\n`(裸 LF = Ctrl+J),给只认 LF 的 TUI 兜底。
    - `^C` = `\x03`(SIGINT)。粘滞 Ctrl 只对键条上的字符键生效,而键条没有 `c` 键,
      所以在此之前 Ctrl+C 在移动端根本拼不出来。标 `danger` 色以防误按。
    - `PgDn` 走 `PgUp` 长按(此前 `NAMED` 里有序列却没有任何键位入口)。
  - **成品键(`raw`)不叠加粘滞修饰**:`换行`/`LF`/`^C` 的序列里已经含修饰,否则 Alt 锁定时
    `换行` 会发出 `ESC ESC CR`、`^C` 会发出 `ESC ^C`,两者都是垃圾序列。
  - Ctrl/Alt 粘滞:点亮→下一个字符键组合发送(^A 等 C0 控制码映射),再点取消;长按锁定。
  - 键宽=均分(8 键在 360dp 屏约 38px,与系统键盘自身键宽同量级),高 44px;按下反馈走显式
    `.pressed` 类(`pointerdown` 被 preventDefault 后 `:active` 在部分 WebView 不再触发)。
- 手势:双指捏合调 fontSize(9-20 夹取,实时 fit+resize,存档);长按=xterm 原生选择复制
  (`term.onSelectionChange`→浮出「复制」小钮);**不做单指横滑切会话**(留给系统返回手势)。
- 字号也可从三点菜单「终端字号」radio sheet 调(可达性兜底)。

### 7e. 审阅 tab `#reviewView`(reviewState 保留,渲染层重做)

- 大标题「审阅」+ 未读统计角标(pushed_unread);搜索框。
- 筛选:横滑 chip 单行(全部/待审/已通过/已驳回/已归档 + tier 组),状态即点即筛(保留 reviewState
  逻辑);_stats 角标并入 chip 数字。
- 列表行:左 40 图标(按 material kind 分形:报告/图/网页/问题),标题两行截断,副行
  `kind · plan 尾段 · 相对时间`,右侧 tier 色点+「新」标;时间桶分组。
- 批量:页头「选择」文字钮 → 行首现圆形勾选框 + 底部固定操作条(全选/通过/驳回/删除 danger)——
  替代旧 selectBar;退出=「取消」。
- 详情推入页:顶栏(返回+标题+三点:归档/标已读/复制链接);正文限宽 720px 居中,md/图片/iframe
  沿用现有渲染路径(含图片批注、mdlines 批注——**功能原样迁移**,样式换 token);
  操作固定底条(玻璃):通过(ok)/驳回(bad)/搁置/评论——替代滚到底才看得到的按钮组。
- 平板 ≥840px:双栏 master-detail(左 360px 列表+右详情),`verdict_changed` 守卫保留。

### 7f. 项目 tab `#projectsView`(projectsState 保留)

- 大标题「项目」+ segmented(项目/任务/计划)+状态 chip 横滑(+计划板的项目筛选 chip)。
- 行/详情:同一套 listRow + 推入详情(限宽、meta 徽标 token 化);只读不变。

### 7g. 我的 tab `#meView`(新)

分组设置列表(iOS 式;分区标题小灰字):
- **连接**:主机行(当前地址,点→连接编辑页:输入+连接+状态,即现 settingsView 内容成为推入页);
  连接状态行(绿点已连接/红点断开+「重试」)。
- **外观**:字号(点→radio sheet 四档)/减少透明度(toggle,`lofa.reduceGlass`)/减少动效(toggle,
  `lofa.reduceMotion`,与系统 prefers-reduced-motion 或逻辑)。
- **终端**:默认字号(radio sheet)。
- **工具**:代码面板(推入全屏 iframe,悬浮返回钮保留)/笔记(推入全屏 iframe)。
- **关于**:版本行(versionName,点 5 次无彩蛋)/检查更新(点→checkUpdate,有新版行内出现「更新」
  accent 按钮;OTA 下载安装逻辑不变)。全局 update 横幅改为:检测到新版时 toast 一次+「我的」tab
  红点,不再顶部横幅。

### 7h. 全局

- 离线:core 健康探测失败→banner 红条(全 tab 可见)+ 会话/审阅列表保留已加载内容置灰;composer
  发送失败 toast。空 base(首次)→ 直接落「我的→连接」编辑页(替代旧 emptyView 全屏卡)。
- remote.js `navigate` op 改为 `router.open(...)` 语义(tab 名或 `session:<id>`)。
- 通知(NOTIF)文案/逻辑不变。
- e2e 钩子:所有关键交互元素保持稳定 id(`#fabNew #newSheet #chatSend #chatInput #termKeys
  #sessionsList #reviewList` 等,spec 内 id 即契约,测试按 id 断言)。

## 8. 文件架构(新)

```
app/www/
  index.html            骨架:壳元素 + 全部 view 容器(空壳) + css/js 引用,≤150 行,无内联样式
  css/
    tokens.css          设计 token 唯一真源(色/玻璃/圆角/字阶/间距/动效曲线/z 层)
    base.css            reset·背景(液态玻璃承托层)·排版·safe-area
    components.css      组件套件(按钮/行/卡/chip/sheet/modal/toast/nav/FAB/swipe/segmented)
    views/
      sessions.css  chat.css  term.css  review.css  projects.css  settings.css  misc.css
  js/
    core.js             连接/api/store/LOG/NOTIF/OTA/字号(保留重组,去 showView)
    router.js           新:视图栈路由(push/pop/replace/tab 切换/转场/Android 返回/深链)
    ui.js               新组件套件(sheet/modal/toast/actionList/swipeRow/fab/segmented/emptyState)
    app.js              boot:接线 + tab 框架 + OTA 横幅 + remote 启动
    sessionsView.js     统一会话空间(chat + PTY 合列)
    chatView.js         对话屏
    chatRender.js       消息渲染(markdown/工具卡/thinking)
    termView.js         终端屏(xterm + PTY WS)
    termKeys.js         终端附加键条(纯逻辑可单测)
    reviewView.js / projectsView.js / notesView.js / settingsView.js
    normalizedChat.js / ws.js / reviewState.js / projectsState.js / remote.js(保留)
  vendor/xterm.js xterm.css addon-fit.js
```

规矩:**view 之间零相互 import**;共享只经 core/router/ui。每个 view 拥有自己的 css 文件与
index.html 里自己的容器节点,并行开发不踩脚。

## 9. 模块接口契约(并行执行的接缝,违反=返工)

- index.html 静态骨架只含:`#ambient` 背景层 · `#banner` 连接条 · `#app` 壳 · 全部 view **空容器** ·
  `#bottomNav`(4 tab)· `#toast`;xterm 以 `<script src="vendor/xterm.js">` + `vendor/addon-fit.js` +
  `<link vendor/xterm.css>` 全局引入(UMD 暴露 `window.Terminal`/`window.FitAddon`,termView 用全局,
  **不要 ES import vendor**)。css 全部在 head 静态 link(tokens→base→components→views/*)。
- view 容器 id(固定):`sessionsView chatView termView reviewView reviewDetailView projectsView
  projectDetailView meView connectView notesView codeView`。各 view 内部 DOM 由各自模块 init() 渲染。
- **router API**(js/router.js):`init({tabs, defaultTab})`(tabs: name→rootViewId)· `tab(name)` ·
  `push(viewId)` · `pop()` · `back()→bool` · `open(kind, payload)`(经 `registerOpener(kind, fn)`,
  app.js 注册;kind=chat/term/review-detail/project-detail/notes/code/connect 或 tab 名)·
  `current()` · `onChange(cb)`。底 tab 显隐/转场/≥840 审阅双栏由 router 统一管。
- **view 模块导出**(app.js 只认这套):
  `sessionsView: init(), load()` ·
  `chatView: init(), open(meta)`(meta={id,name,provider,effort,model,active_plan})·
  `termView: init(), open(meta)`(meta=PTY to_meta)·
  `reviewView: init(), load(), openDetail(id)` · `projectsView: init(), load()` ·
  `settingsView: init(), load(), openConnect()` · `notesView: openNotes(), openCode()`。
- **core.js 保留导出**:`api apiJson store toast LOG NOTIF connect normBase getSaved save hostLabel
  wsUrl FONT_SCALES getFontScale setFontScale initFontScale mdToHtml esc checkUpdate doUpdate
  fetchCodeConfig codeUrl startPolling` + 新增 `termWsUrl(sid)`(→ `/api/cc/sessions/{sid}/ws`)+
  `promptModal/confirmModal/pickModal` 桥接到 ui 新实现(旧签名不变)。
- **sessionsState.js**(纯函数可单测):`normalizeSessions(chatItems, ptyItems, activeMap) → rows` ·
  `groupRows(rows, now) → sections` · `recentCwds(rows) → string[]`。
- **termKeys.js**(纯逻辑可单测):键位表常量 · `keySequence(key, {ctrl,alt}) → 终端写入序列`
  (含 C0 控制码/CSI 方向键/Home End PgUp PgDn)· 粘滞修饰键状态机。
- **稳定 e2e id**(测试契约,不许改名):`#fabNew #newSheet #sessionsList #sessionsSearch
  #chatMsgs #chatInput #chatSend #chatHeadPill #termScreen #termKeys #reviewList #reviewFilters
  #reviewActions #projectsList #meList #bannerBar`;`openSheet({id})` 支持给 sheet 根设 id。
- 文件所有权:并行阶段每个工人只改自己名下文件;公共文件(index.html/router/ui/core/app/
  tokens/base/components.css)在地基阶段定稿,后续阶段发现公共层 bug 报告而不擅改(集成阶段统一修)。

## 10. 测试计划

- 保留:`frames.contract`(reducer 契约)、`normalizedChat.test`、`reviewState/projectsState.test`、
  review/projects/automation schema 契约。
- 重写:`chatRender.test`(新渲染形态)、`ui.test`(新组件)、`reviewView/projectsView.test`(新 DOM)。
- 新增:`router.test`(视图栈/返回语义)、`termKeys.test`(附加键条:普通键/组合键/粘滞 Ctrl 序列)、
  `sessionsState.test`(chat+PTY 合列排序/分组/四态徽标归一)。
- e2e 全部重写:`sessions.spec`(合列/新建流/切换)、`chat.spec`(发消息/流式/工具卡/中断/设置)、
  `term.spec`(PTY mock WS:snapshot 重画/input 回显/附加键/exit 态)、`review.spec`、`projects.spec`、
  `nav.spec`(tab/返回/深链)。PTY WS 用 playwright routeWebSocket mock。
- 跑法不变:`tools/test/web` 下 `npx vitest run` / `npx playwright test e2e/`。

## 11. 2026-07-16 深夜批:交互修缮 + 项目双视图(用户验收反馈第二批,定稿)

### 11a. 会话标题链 v3 与活跃判定重构(sessionsState)
- 标题优先级:用户改名 > digest.title(中文主题)> **preview(/active item 的首条用户输入,
  clip 48——原生实质内容,逐会话唯一)** > last_user/last_did 摘录 > 机器名剥前缀。
- 状态判定:running 只表示「正在产出」(chat: meta.running 或 active=working;PTY: 后端 `working`
  信号,近 8s 有输出)。所有行一律按 lastActive 时间桶排,不再单设「进行中」组(2026-07-18 修订);
  「待输入」/spinner 只作行内徽标不改分组。
- lastActive 取新鲜度最高者:chat=transcript mtime(/active 命中)否则 started_at;
  pty=last_output_at;recoverable=响应里可得的时间字段,取不到则沉底。
  效果=整个列表就是「本机使用记录」序。
- **PTY 点击即自动续接**:recoverable 行点击直接 POST /resume → 进终端,无确认弹窗(失败 toast)。

### 11b. 审阅沉浸阅读(reviewView 详情)
- 正文向下滚动 → 顶栏与底部操作条平移出屏(全屏沉浸);向上滚动或点正文空白 → 召回。
- iframe 类材料(html/custom_web_template)滚动事件拿不到:顶栏加「沉浸」钮切换 chrome,
  点 iframe 外边缘也可召回。操作(通过/驳回/评论)只在 chrome 可见时存在。参照 Readwise Reader。

### 11c. 筛选去电脑化(审阅/项目)
- 删多行 chip 筛选条。审阅=segmented(待审/已处理/全部)+ 一个「筛选」pill(点开 sheet:
  tier 单选、含已归档 toggle、清除);pill 上显示生效筛选数角标。
- 项目=segmented(项目/任务/计划)+「筛选」pill(sheet:状态单选、计划板的项目单选)。

### 11d. 层级/穿层修复
- 时间桶 sticky 小标题必须实底(--bg 上加轻渐变),不得让行内容从其上/另一侧透出;
- 列表滚动容器与大标题收缩的 z/overflow 全面审计;sheet/menu scrim 与内容对位核查;
- 逐屏截图验收(会话/审阅/项目)。

### 11e. 项目双视图(dashboard 桌面端 + LOFA 同步适用)
- 数据源:`omnicompany/config/project_views.yaml`(新),经 dashboard 后端下发
  (并入 /api/projects 响应或新只读端点 /api/project-views):
  `apps: [{id,label,icon,url}]`(App 视图=长期审阅面直达:demo/MC控制台/aigc审阅台/AIWorkspace 站…)
  `projects: {<id>: {thumb?, links: [{label,url}]}}`(每项目自定义快速入口:
  行者无乡/vilo→demo(+叙事工作台),blockworks→blockworks审阅台…)
- **App 视图(2026-07-17 修订:真启动器)**:紧凑宫格=**审阅面 apps 优先置顶 + 全部项目图标随后**
  (项目用 icon/识别色,pinned 在前再按分组序);apps 点击直达 URL,项目图标点击进项目详情。
  桌面与 LOFA 同构,LOFA 更紧凑。
- **列表视图(取代卡片;2026-07-17 修订:加料+可折叠)**:按分组渲染,**分组头可折叠**
  (chevron,localStorage 记忆);行=展示图缩略 + 完整名称 + 一行简介(short/desc)+
  活跃(近 7 天活跃点 + 相对时间文本,不用状态标签)+ 快速入口按钮行 + 打开项目。
- 两视图切换记忆(localStorage);LOFA 项目 tab 顶部 segmented(应用/列表/任务/计划)。

### 11f. 桌面 dashboard 终端渲染同步
- frontend 的 @xterm 升 6.0.0 配套家族;Editor.tsx 补 windowsPty{conpty,19045}、
  minimumContrastRatio 4.5、UnicodeGraphemesAddon('15-graphemes')、webgl onContextLoss 兜底。
