// sessionsState.js — 统一会话空间的纯逻辑层(无 DOM,可单测)。
//   把两族后端数据(chat 会话 + PTY 终端会话,含 recoverable 与四态徽标)
//   归一成统一行模型,再按时间桶分组(running 行自然置顶今天组),并聚合最近工作目录。
//   sessionsView 只做 DOM 与 API;归一/分组/排序全部在此。

// provider 展示名与颜色键(颜色变量在 tokens.css:--provider-*)。
export const PROVIDER_LABEL = { claude_code: 'Claude', codex: 'Codex', controller: '总控', omni_agent: 'Omni', kimi: 'Kimi', opencode: 'OpenCode', term: '终端' }
const PROVIDER_KEY = { claude_code: 'claude', codex: 'codex', controller: 'omni', omni_agent: 'omni', kimi: 'kimi', opencode: 'opencode', term: 'term' }

const DAY = 86400000

// 时间归一:后端可能给 epoch 秒(Python float)/epoch 毫秒 / ISO 字符串。统一到毫秒;不可解析→0。
export function toEpochMs(v) {
  if (v == null) return 0
  if (typeof v === 'number') return v < 1e12 ? Math.round(v * 1000) : Math.round(v)
  const n = Date.parse(v)
  return Number.isNaN(n) ? 0 : n
}

// cwd 尾段:取最后一个非空路径段(兼容 / 与 \)。
export function tailCwd(cwd) {
  const parts = String(cwd || '').replace(/[\\/]+$/, '').split(/[\\/]+/)
  return parts.length ? parts[parts.length - 1] : ''
}

export function providerLabel(p) { return PROVIDER_LABEL[p] || p || '' }
export function providerKey(p) { return PROVIDER_KEY[p] || 'claude' }

// PTY 命令 → 展示名。cmd 为 null/空即默认 claude CLI。
export function termLabel(cmd) {
  if (!cmd || !cmd.length) return 'Claude CLI'
  const head = String(cmd[0] || '').toLowerCase()
  if (/codex/.test(head)) return 'Codex CLI'
  if (/kimi/.test(head)) return 'Kimi CLI'
  if (/opencode/.test(head)) return 'OpenCode CLI'
  if (/powershell|pwsh/.test(head)) return 'PowerShell'
  if (/cmd(\.exe)?$/.test(head)) return '命令提示符'
  if (/claude/.test(head)) return 'Claude CLI'
  return tailCwd(cmd[0]) || String(cmd[0])
}

// 从四态徽标响应里取某会话的命中项(容忍多种形状:map / {items} / 数组 / Map)。
// ⚠ 真实 /api/cc/chat/active 的 items[].session_id 是 transcript 的 claude_session_id,
// 不是 chat 会话 id —— 调用方要把两个候选键都传进来。命中返回 {state, mtime} 或 null。
function activeHit(activeMap, ids) {
  if (!activeMap) return null
  const asHit = (v) => {
    if (!v) return null
    if (typeof v === 'string') return { state: v, mtime: 0, title: '', preview: '', hint: '' }
    const state = v.state || v.status || ''
    if (!state) return null
    return {
      state,
      mtime: Number(v.mtime) || 0,
      title: (v.digest && v.digest.title) ? String(v.digest.title).trim() : '',
      // preview = transcript 首条用户输入(逐会话唯一的实质内容),标题链主力。
      preview: String(v.preview || '').trim(),
      hint: String(v.last_user || v.last_did || '').trim(),
    }
  }
  for (const id of ids) {
    if (!id) continue
    if (typeof activeMap.get === 'function') { const h = asHit(activeMap.get(id)); if (h) return h }
    else if (Array.isArray(activeMap)) {
      const h = asHit(activeMap.find((a) => a && (a.id === id || a.session_id === id)))
      if (h) return h
    } else if (activeMap.items || activeMap.active) {
      const h = activeHit(activeMap.items || activeMap.active, [id]); if (h) return h
    } else { const h = asHit(activeMap[id]); if (h) return h }
  }
  return null
}

// 后端默认会话名形如「Claude 编程 · omnicompany · 07月16日 10:52」:三段 · 分隔、日期结尾。
// 这种机器名前缀全相同、可区分段在尾部,列表里截断后全部长一样——不当标题用。
export function isDefaultName(name) {
  const s = String(name || '').trim()
  if (!s || s === '未命名智能体对话') return true
  return /^[^·]{1,16} · .{1,60} · \d{1,2}月\d{1,2}日 \d{1,2}:\d{2}$/.test(s)
}

// 可读标题(优先级 §11a):用户改过的名 > digest 一句话中文主题 >
// preview(首条用户输入,clip 48) > last_user/last_did 摘录(clip 36) >
// 默认机器名去掉相同前缀(留 工作区 · 日期) > provider 兜底。
export function clipSessionTitle(s, n = 48) {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

// 没有内容标题时也必须有可区分标识:来源 + 会话 id 尾号。
// Stable identifier is independent from the content title and must always be visible.
export function sessionIdentifier(m) {
  const base = providerLabel(m && m.provider) || '会话'
  const id = String((m && m.id) || '').trim()
  return id ? base + ' · ' + id.slice(-6) : base
}

export function chatIdentityTitle(m) {
  const provider = providerLabel(m && m.provider) || '会话'
  const id = String((m && m.id) || '').trim()
  return id ? provider + ' 会话 · ' + id.slice(-6) : provider + ' 会话'
}

export function historySessionTitle(payload) {
  const messages = (payload && (payload.messages || payload.history)) || []
  const find = (role) => messages.find((m) => m && m.kind === 'text' && m.role === role && String(m.content || m.text || '').trim())
  const hit = find('user') || find('assistant')
  return hit ? clipSessionTitle(hit.content || hit.text, 48) : ''
}

export function resolveChatHeaderTitle(m, firstUserText, titleHint) {
  const name = String((m && m.name) || '').trim()
  if (name && !isDefaultName(name)) return name
  const hinted = clipSessionTitle(titleHint, 48)
  if (hinted) return hinted
  const temporary = clipSessionTitle(firstUserText, 48)
  if (temporary) return temporary
  if (name && name !== '未命名智能体对话') {
    const parts = name.split(' · ')
    if (parts.length >= 3) return parts.slice(1).join(' · ')
  }
  return chatIdentityTitle(m)
}

function chatTitle(m, hit) {
  const name = (m.name || '').trim()
  if (name && !isDefaultName(name)) return name
  if (hit && hit.title) return hit.title
  if (hit && hit.preview) return clipSessionTitle(hit.preview, 48)
  if (hit && hit.hint) return clipSessionTitle(hit.hint, 36)
  if (name && name !== '未命名智能体对话') {
    const parts = name.split(' · ')
    if (parts.length >= 3) return parts.slice(1).join(' · ')
  }
  return chatIdentityTitle(m)
}

// chat meta + 四态 → 统一状态。running=产出中;waiting=活着但闲置(等用户);ended=已结束。
// 状态只作行内徽标,分组一律按时间桶落位(见 groupRows)。
function chatStatus(m, active) {
  const alive = m.alive !== false && !m.ended_at
  if (!alive) return 'ended'
  if (active === 'working' || m.running) return 'running'
  return 'waiting'   // waiting/done/idle:活着但非产出中 = 等用户
}

function isRecoverable(m) {
  return m.__recoverable === true || m.recoverable === true || m.status === 'recoverable'
}

// PTY meta → 统一状态。recoverable 优先;进程死=ended;活着看 working(近几秒有输出)
// —— TUI 回合结束后进程常驻等输入, 单看 alive 会让所有终端会话永远显示进行中。
function ptyStatus(m) {
  if (isRecoverable(m)) return 'recoverable'
  if (m.alive === false) return 'ended'
  return m.working ? 'running' : 'waiting'
}

// 归一:两族原始 items + 四态 map → 统一行数组。
//   chat 已归档剔除;行模型 = {id,kind,title,provider,providerName,cwd,status,lastActive,meta}。
export function normalizeSessions(chatItems, ptyItems, activeMap) {
  const rows = []
  ;(chatItems || []).forEach((m) => {
    if (!m || !m.id) return
    if (m.archived === true) return
    const hit = activeHit(activeMap, [m.claude_session_id, m.id])
    const active = hit ? hit.state : ''
    // 最近活动:/active 的 transcript mtime(秒)比 started_at 新鲜,命中时优先
    const mtimeMs = hit && hit.mtime ? hit.mtime * 1000 : 0
    // 弱标题=只能剥前缀/provider 兜底(/active 没带来任何实质内容)。
    // 视图层会对弱标题行懒取一次 history 首条用户消息并缓存(标题不会变,一次成本)。
    const titleWeak = isDefaultName((m.name || '').trim()) && !(hit && (hit.title || hit.preview || hit.hint))
    rows.push({
      id: m.id,
      kind: 'chat',
      title: chatTitle(m, hit),
      identity: sessionIdentifier({ id: m.id, provider: m.provider || 'claude_code' }),
      titleWeak,
      provider: m.provider || 'claude_code',
      providerName: providerLabel(m.provider),
      cwd: m.cwd || '',
      status: chatStatus(m, active),
      lastActive: Math.max(mtimeMs, toEpochMs(m.ended_at || m.started_at)),
      meta: m,
    })
  })
  ;(ptyItems || []).forEach((m) => {
    if (!m || !m.id) return
    rows.push({
      id: m.id,
      kind: 'term',
      title: termLabel(m.cmd),
      identity: sessionIdentifier({ id: m.id, provider: 'term' }),
      provider: 'term',
      providerName: '终端',
      cwd: m.cwd || '',
      status: ptyStatus(m),
      // alive=last_output_at;recoverable 无 last_output_at,退 ended_at(被杀时刻)再退 started_at。
      lastActive: toEpochMs(m.last_output_at || m.ended_at || m.started_at || m.created_at),
      meta: m,
    })
  })
  return rows
}

const byActiveDesc = (a, b) => b.lastActive - a.lastActive

// 时间桶归属(相对 now,按本地日历):今天/昨天/本周(近 7 天)/更早。
function bucketKey(ts, now) {
  const start = new Date(now); start.setHours(0, 0, 0, 0)
  const startToday = start.getTime()
  if (ts >= startToday) return 'today'
  if (ts >= startToday - DAY) return 'yesterday'
  if (ts >= startToday - 6 * DAY) return 'week'
  return 'older'
}

const SECTION_TITLE = { today: '今天', yesterday: '昨天', week: '本周', older: '更早' }
const SECTION_ORDER = ['today', 'yesterday', 'week', 'older']

// 分组: 一律按 lastActive 落时间桶, 不再单设「进行中」置顶组 —— running 会话的
// lastActive 本身就是最新输出时刻, 自然排在「今天」最前; 状态交给行内徽标
// (spinner/待输入) 表达, 组名和状态互不重复。空组略过。
export function groupRows(rows, now) {
  now = now || Date.now()
  const buckets = { today: [], yesterday: [], week: [], older: [] }
  ;(rows || []).forEach((r) => {
    buckets[bucketKey(r.lastActive, now)].push(r)
  })
  return SECTION_ORDER
    .filter((k) => buckets[k].length)
    .map((k) => ({ key: k, title: SECTION_TITLE[k], rows: buckets[k].slice().sort(byActiveDesc) }))
}

// 最近工作目录:两族聚合、去重、按最近活跃排序、取前 6(新建 sheet 的目录 chips 用)。
export function recentCwds(rows, limit) {
  limit = limit || 6
  const seen = new Set(), out = []
  ;(rows || []).slice().sort(byActiveDesc).forEach((r) => {
    const c = (r.cwd || '').trim()
    if (!c || seen.has(c)) return
    seen.add(c); out.push(c)
  })
  return out.slice(0, limit)
}

// 前端搜索过滤(标题 / cwd,大小写不敏感)。
export function filterRows(rows, q) {
  q = (q || '').trim().toLowerCase()
  if (!q) return rows || []
  return (rows || []).filter((r) =>
    (r.title || '').toLowerCase().includes(q) || (r.cwd || '').toLowerCase().includes(q))
}

// 相对时间短标(副行末段用)。
export function relTime(ts, now) {
  now = now || Date.now()
  if (!ts) return ''
  const d = now - ts
  if (d < 0) return '刚刚'
  if (d < 60000) return '刚刚'
  if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前'
  if (d < DAY) return Math.floor(d / 3600000) + ' 小时前'
  if (d < 2 * DAY) return '昨天'
  if (d < 7 * DAY) return Math.floor(d / DAY) + ' 天前'
  const dt = new Date(ts)
  return (dt.getMonth() + 1) + '月' + dt.getDate() + '日'
}
