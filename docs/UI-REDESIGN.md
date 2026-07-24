# LOFA 对话界面改造（第一版）【已废弃:被 UI-REDESIGN-V2.md 取代(2026-07-16 全前端重做),本文只留档】

计划锚点：`remote-client/[2026-06-27]LOFA-DESKTOP-PARITY` M12（对话交互移动化）。
本文只记「改造依据 + 逐界面方案 + 标杆」，进度不在此（进度看 whatnow）。

## 1. 为什么改

第一阶段（M1）把电脑端对话能力搬到手机，做法是「命令/选项全常驻平铺」：会话对话页顶部堆了
多会话切换条（`#sessionStrip`）、一排工具按钮（effort/model/压缩/改名/绑定计划）、计划注入横幅、
底部又常驻一排 slash 快捷条。能力齐了，但手机上这套「桌面搬运」的信息密度过高、把消息流挤到很小，
用户强烈不满。

对齐三路成熟移动 App 的做法后，统一原则是「**点一下才出现的浮层 / sheet**」：平时把屏幕让给内容，
需要时才召出操作面。

## 2. 标杆（逐条对应）

| 现状（常驻平铺） | 改成 | 标杆 |
|---|---|---|
| 底部常驻 slash 快捷条 | 敲 `/` 才弹补全浮层，选完收起 | Discord / Telegram 斜杠命令 |
| 一排常驻工具按钮 | 合进「会话设置」底部 sheet | Claude App 模型名点一下弹菜单 |
| 常驻计划注入横幅 | 一次性 toast + composer 旁小 chip | ChatGPT「Memory updated」 |
| 常驻多会话切换条 | 收进「切换会话」sheet | Claude / ChatGPT 会话抽屉 |
| 字号偏大、无档位 | 设置页字号档位（小/中/大/特大），CSS 变量倍数缩放 | Material 3 text-resizing |
| 顶栏与常驻条抢注意力 | 顶栏瘦身，消息流最大化，键盘弹出隐藏非必要 chrome | setproduct chat 模板 |

## 3. 通用件（供全局复用）

- `js/ui.js` `openSheet({title, rows})`：Material 3 风格底部 sheet。结构 = scrim + 拖拽手柄 + 标题 +
  行列表。行类型：`header`（分区标题）/`row`（设置项：左标签右取值，可禁用）/`action`（图标+文字动作）/
  `divider`（分隔线）/`item`（自定义 html 行，用于会话列表、上下文列表）。每个可点行的 `onTap(close)`
  拿到关闭函数，便于「关 sheet → 再开 pickModal」。scrim 点击 / 手柄下滑 / 返回键都能关。
- `js/core.js` 全局字号系统：`--font-scale` CSS 变量（小 1 / 中 1.15 / 大 1.3 / 特大 1.5，默认「小」，
  比原来略小）。只缩放正文/消息的 `font-size`（行高用无单位值随字号缩放），**按钮 padding、图标、间距不缩放**，
  避免撑变形。存 `localStorage(lofa.fontScale)`，对话消息、审阅正文、笔记/详情正文全局生效。

配色沿用 frostpane 冷色玻璃 token（`--glass`/`--blur`/`--line`/`--accent` 等），不另起一套。

## 4. 逐界面方案（对话页 `#convView`）

1. **slash 补全浮层**：删 `#slashBar`。composer 上方放 `#slashPop`（绝对定位，默认隐藏）。
   composerInput 输入时，值形如 `/xxx`（`/` 开头、还没打空格）→ 按前缀实时过滤命令列表
   （/help /clear /compact /context /cost）弹出；`↑/↓` 移高亮、`Enter`/点选把命令**填入输入框并补一个空格**
   （不自动发送，可继续加参数），`Esc` 或值不再是 `/命令` 形态则隐藏。命令仍原样作为 `user.message` 发，
   前端不解析。

2. **会话设置 sheet**：删 `#convTools` 一排按钮。对话页顶部瘦条 `#convHead` 放两个入口：
   「切换会话」图标 + 「设置」入口（显示当前 model 名，点开设置 sheet）。sheet 内容：
   - 分区①「当前会话」：模型（点→pickModal 改）、推理强度 effort（点→pickModal 改，保留 provider 差异化：
     codex 选项含 minimal；omni_agent 不支持 → 该行禁用、显示「不支持」）。
   - 分隔线。
   - 分区②动作（图标+文字）：压缩上下文 / 改名 / 绑定计划。
   所有原功能仍走原 API（`/metadata` `/compact` `/name` `/active_plan`），只换收纳位置。

3. **上下文 toast + chip**：删常驻横幅（`context_event` 不再在消息流内渲染）。到达时 `toast('已注入上下文 N 项')`
   一次；composer 旁小 chip `📎N`（N=累计注入项数，0 则隐藏），点击弹 sheet 看注入详情（summary + 计划 id）。
   数据来源 = reducer 里的 `type:'context'` items（渲染层跳过它们，chip/ sheet 复用同一份数据）。

4. **切换会话 sheet**：删常驻 `#sessionStrip`。`#convHead` 的「切换会话」图标点开 sheet，列出其它活跃会话
   （provider + 运行态徽标，复用 `sessionItems`），点选切换。无其它会话时提示空态。

5. **字号档位**：`#settingsView` 加「字号」一行四档，见 §3。

6. **顶栏瘦身 + 消息流最大化**：`#convHead` 是一条很矮的玻璃条；删掉三条常驻区后 `#msgs` 占据更多空间。
   composerInput 聚焦（软键盘弹出）时给 `body.kbd`，隐藏 `#convHead` 的 model 副标题等非必要 chrome。

## 5. 测试适配

- e2e（`chat.spec.js`）：slash 改为「输入 `/` → `#slashPop` 弹出 → 点选填入」；工具栏改为「点 `#cvSettings`
  → sheet 里改 effort」；omni_agent 置灰、codex minimal 两条断言移到 sheet 行上；context 改为断言 toast + chip。
- unit：新增 `ui.js` 的 `openSheet` 结构测（jsdom）与字号系统测；`normalizedChat` / `chatRender` 契约不变
  （context item 仍进 state，只是不再 inline 渲染）。
