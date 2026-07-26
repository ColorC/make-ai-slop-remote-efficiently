// sessionsState 纯逻辑单测 — 锁住两族归一 / 分组边界 / 最近目录聚合。
// 纯函数,node 环境即可(无 DOM)。对齐 §2 后端契约与 §7a 归一规则。
import { describe, it, expect } from 'vitest'
import {
  normalizeSessions, groupRows, recentCwds, filterRows,
  toEpochMs, tailCwd, termLabel, providerLabel, relTime, historySessionTitle,
} from '../../../../app/www/js/sessionsState.js'

// 固定"现在"= 2026-07-16 12:00 本地,便于时间桶断言。
const NOW = new Date(2026, 6, 16, 12, 0, 0).getTime()
const DAY = 86400000


describe('session title and legacy backfill', () => {
  it('uses smart digest instead of the first-message preview when both exist', () => {
    const machine = 'Codex 编程 · lofa · 07月16日 10:52'
    const active = { items: [{ session_id: 'cs-title', status: 'done', digest: { title: '智能总结标题' }, preview: '第一条消息' }] }
    const [row] = normalizeSessions([{ id: 'chat-title', provider: 'codex', name: machine, claude_session_id: 'cs-title', alive: true }], [], active)
    expect(row.title).toBe('智能总结标题')
    expect(row.titleWeak).toBe(false)
  })
  it('uses the first text message in original order when no digest exists', () => {
    expect(historySessionTitle({ messages: [
      { kind: 'context_event', role: 'system', content: '上下文' },
      { kind: 'text', role: 'assistant', content: '真正的第一条消息' },
      { kind: 'text', role: 'user', content: '第二条消息' },
    ] })).toBe('真正的第一条消息')
  })
  it('leaves context-only or empty sessions untitled for the fallback name', () => {
    expect(historySessionTitle({ messages: [{ kind: 'context_event', role: 'system', content: '上下文' }] })).toBe('')
    expect(historySessionTitle({ messages: [] })).toBe('')
  })
})

describe('toEpochMs 时间归一', () => {
  it('epoch 秒 → 毫秒', () => { expect(toEpochMs(1700000000)).toBe(1700000000000) })
  it('epoch 毫秒原样', () => { expect(toEpochMs(1700000000000)).toBe(1700000000000) })
  it('ISO 字符串可解析', () => { expect(toEpochMs('2026-07-16T00:00:00Z')).toBe(Date.parse('2026-07-16T00:00:00Z')) })
  it('空 / 不可解析 → 0', () => { expect(toEpochMs(null)).toBe(0); expect(toEpochMs('xxx')).toBe(0) })
})

describe('tailCwd / termLabel / providerLabel', () => {
  it('cwd 尾段兼容正反斜杠与结尾分隔符', () => {
    expect(tailCwd('E:/WindowsWorkspace/lofa')).toBe('lofa')
    expect(tailCwd('C:\\repo\\walker\\')).toBe('walker')
    expect(tailCwd('')).toBe('')
  })
  it('termLabel 从 cmd 推断', () => {
    expect(termLabel(null)).toBe('Claude CLI')
    expect(termLabel([])).toBe('Claude CLI')
    expect(termLabel(['codex'])).toBe('Codex CLI')
    expect(termLabel(['powershell'])).toBe('PowerShell')
  })
  it('providerLabel 覆盖三 provider', () => {
    expect(providerLabel('claude_code')).toBe('Claude')
    expect(providerLabel('codex')).toBe('Codex')
    expect(providerLabel('omni_agent')).toBe('Omni')
  })
})

describe('normalizeSessions — chat 四态归一', () => {
  const base = { provider: 'claude_code', cwd: '/w/a', started_at: 1700000000 }
  it('working → running', () => {
    const [r] = normalizeSessions([{ ...base, id: 'c1', alive: true }], [], { c1: 'working' })
    expect(r).toMatchObject({ kind: 'chat', status: 'running', provider: 'claude_code', cwd: '/w/a' })
  })
  it('running 标志(无四态)也 → running', () => {
    const [r] = normalizeSessions([{ ...base, id: 'c1', alive: true, running: true }], [], {})
    expect(r.status).toBe('running')
  })
  it('waiting → waiting', () => {
    const [r] = normalizeSessions([{ ...base, id: 'c2', alive: true }], [], { c2: 'waiting' })
    expect(r.status).toBe('waiting')
  })
  it('done / idle(活着但非产出)→ waiting', () => {
    const [d] = normalizeSessions([{ ...base, id: 'c3', alive: true }], [], { c3: 'done' })
    const [i] = normalizeSessions([{ ...base, id: 'c4', alive: true }], [], { c4: 'idle' })
    expect(d.status).toBe('waiting')
    expect(i.status).toBe('waiting')
  })
  it('已结束(alive=false 或有 ended_at)→ ended', () => {
    const [a] = normalizeSessions([{ ...base, id: 'c5', alive: false }], [], {})
    const [b] = normalizeSessions([{ ...base, id: 'c6', alive: true, ended_at: 1700001000 }], [], { c6: 'working' })
    expect(a.status).toBe('ended')
    expect(b.status).toBe('ended')   // ended_at 存在压过四态
  })
  it('真实 /active 形状:items[].session_id=claude_session_id 配对 + mtime 提升 lastActive', () => {
    const active = { count: 1, window_sec: 600, items: [{ session_id: 'csid-9', provider: 'claude', status: 'working', mtime: 1800000000 }] }
    const [r] = normalizeSessions([{ ...base, id: 'c9', claude_session_id: 'csid-9', alive: true }], [], active)
    expect(r.status).toBe('running')                    // 按 claude_session_id 配上 working
    expect(r.lastActive).toBe(1800000000000)            // mtime(秒→毫秒)压过 started_at
    const [miss] = normalizeSessions([{ ...base, id: 'csid-x', claude_session_id: 'nope', alive: true }], [], active)
    expect(miss.status).toBe('waiting')                 // 配不上→活着兜底 waiting
  })
  it('标题可读化:默认机器名让位给 digest 中文主题', () => {
    const machine = 'Claude 编程 · omnicompany · 07月16日 10:52'
    const active = { items: [{ session_id: 'cs-t', status: 'done', mtime: 1800000000, digest: { title: '重构统一会话空间列表' }, last_user: '把列表改成…' }] }
    const [r] = normalizeSessions([{ ...base, id: 'ct', name: machine, claude_session_id: 'cs-t', alive: true }], [], active)
    expect(r.title).toBe('重构统一会话空间列表')
  })
  it('标题可读化:preview(首条用户输入)优先于 last_user,超长 clip 48', () => {
    const machine = 'Claude 编程 · omnicompany · 07月16日 10:52'
    const long = '在 E:/WindowsWorkspace/omnicompany 下摸清以下事实并逐条汇报,读文件为准不要凭空猜测,先看依赖版本再看渲染配置最后给结论'
    const active = { items: [{ session_id: 'cs-p', status: 'done', mtime: 1800000000, preview: long, last_user: '别的输入' }] }
    const [r] = normalizeSessions([{ ...base, id: 'cp', name: machine, claude_session_id: 'cs-p', alive: true }], [], active)
    expect(r.title).toBe(long.slice(0, 48) + '…')
  })
  it('标题可读化:digest.title 仍压过 preview', () => {
    const active = { items: [{ session_id: 'cs-q', status: 'done', mtime: 1800000000, digest: { title: '主题标题' }, preview: '首条用户输入' }] }
    const [r] = normalizeSessions([{ ...base, id: 'cq', name: 'Claude 编程 · omnicompany · 07月16日 10:52', claude_session_id: 'cs-q', alive: true }], [], active)
    expect(r.title).toBe('主题标题')
  })
  it('title readability:last_user waits for history first-message title;manual name remains', () => {
    const machine = 'Codex 编程 · lofa · 07月16日 10:12'
    const active = { items: [{ session_id: 'cs-u', status: 'waiting', mtime: 1800000000, last_user: '排查隧道断连竞态问题,先看中继日志' }] }
    const [waitingForHistory] = normalizeSessions([{ ...base, id: 'cu', name: machine, claude_session_id: 'cs-u', alive: true }], [], active)
    expect(waitingForHistory.title).not.toBe(active.items[0].last_user)
    expect(waitingForHistory.titleWeak).toBe(true)
    const [renamed] = normalizeSessions([{ ...base, id: 'cv', name: '我的重要任务', claude_session_id: 'cs-u', alive: true }], [], active)
    expect(renamed.title).toBe('我的重要任务')
    expect(renamed.titleWeak).toBe(false)
  })
  it('标题可读化:默认名且无任何提示 → 去掉相同前缀留可区分尾段', () => {
    const [r] = normalizeSessions([{ ...base, id: 'cw', name: 'Claude 编程 · omnicompany · 07月10日 10:11', alive: true }], [], {})
    expect(r.title).toBe('omnicompany · 07月10日 10:11')
  })
  it('titleWeak:仅剥前缀兜底时标弱,拿到 preview/digest 不标', () => {
    const machine = { ...base, id: 'w1', name: 'Claude 编程 · omnicompany · 07月16日 10:52', alive: true }
    const [weak] = normalizeSessions([machine], [], {})
    expect(weak.titleWeak).toBe(true)
    const active = { items: [{ session_id: 'cs-w', status: 'waiting', preview: '修终端渲染' }] }
    const [strong] = normalizeSessions([{ ...machine, claude_session_id: 'cs-w' }], [], active)
    expect(strong.titleWeak).toBe(false)
    const [named] = normalizeSessions([{ ...base, id: 'w2', name: '手改的名字', alive: true }], [], {})
    expect(named.titleWeak).toBe(false)
  })
  it('已归档 chat 剔除', () => {
    const rows = normalizeSessions([{ ...base, id: 'c7', alive: true, archived: true }], [], {})
    expect(rows).toHaveLength(0)
  })
  it('标题回退到 provider 名', () => {
    const [named] = normalizeSessions([{ ...base, id: 'c8', name: '我的任务', alive: true }], [], {})
    const [blank] = normalizeSessions([{ ...base, id: 'c9', name: '  ', alive: true }], [], {})
    expect(named.title).toBe('我的任务')
    expect(blank.title).toBe('Claude 会话 · c9')
  })
})

describe('normalizeSessions — PTY 归一(含 recoverable)', () => {
  it('alive 但无 working 信号的 PTY → waiting,provider=term', () => {
    const [r] = normalizeSessions([], [{ id: 't1', cmd: ['powershell'], cwd: '/w/b', alive: true, last_output_at: 1700000000 }], {})
    expect(r).toMatchObject({ kind: 'term', status: 'waiting', provider: 'term', title: 'PowerShell', providerName: '终端' })
  })
  it('working PTY → running', () => {
    const [r] = normalizeSessions([], [{ id: 't1-working', cmd: ['powershell'], cwd: '/w/b', alive: true, working: true }], {})
    expect(r.status).toBe('running')
  })
  it('recoverable(独立数组标记)→ recoverable', () => {
    const [r] = normalizeSessions([], [{ id: 't2', cmd: null, cwd: '/w/b', alive: false, __recoverable: true }], {})
    expect(r.status).toBe('recoverable')
  })
  it('status=recoverable 亦识别', () => {
    const [r] = normalizeSessions([], [{ id: 't3', cwd: '/w/b', status: 'recoverable' }], {})
    expect(r.status).toBe('recoverable')
  })
  it('死掉且不可恢复 → ended', () => {
    const [r] = normalizeSessions([], [{ id: 't4', cwd: '/w/b', alive: false }], {})
    expect(r.status).toBe('ended')
  })
  it('meta 原样带出(供 view 跳转)', () => {
    const raw = { id: 't5', cmd: ['codex'], cwd: '/w/b', alive: true }
    const [r] = normalizeSessions([], [raw], {})
    expect(r.meta).toBe(raw)
  })
  it('lastActive:alive 用 last_output_at;recoverable 无 last_output_at 退 ended_at', () => {
    const [alive] = normalizeSessions([], [{ id: 't6', cmd: ['powershell'], alive: true, last_output_at: 1700000000, started_at: 1600000000 }], {})
    expect(alive.lastActive).toBe(1700000000000)
    const [rec] = normalizeSessions([], [{ id: 't7', cmd: null, alive: false, __recoverable: true, ended_at: 1700005000, started_at: 1699999000 }], {})
    expect(rec.status).toBe('recoverable')
    expect(rec.lastActive).toBe(1700005000000)   // 无 last_output_at → ended_at(秒→毫秒)
  })
})

describe('groupRows — 统一时间桶', () => {
  const mk = (id, status, ts) => ({ id, kind: 'chat', title: id, provider: 'claude_code', cwd: '/w', status, lastActive: ts })
  it('running/waiting/ended 一律按 lastActive 落时间桶', () => {
    const rows = [
      mk('r1', 'running', NOW - 5000),
      mk('w1', 'waiting', NOW - 1000),
      mk('w2', 'waiting', NOW - 30 * 3600000), // 昨天
      mk('e1', 'ended', NOW - 3 * DAY),
    ]
    const secs = groupRows(rows, NOW)
    expect(secs[0].key).toBe('today')
    expect(secs[0].title).toBe('今天')
    const today = secs.find((s) => s.key === 'today')
    expect(today.rows.map((r) => r.id)).toEqual(['w1', 'r1'])
    const yday = secs.find((s) => s.key === 'yesterday')
    expect(yday.rows.map((r) => r.id)).toContain('w2')
  })
  it('全是 waiting(无 running)时不出现「进行中」组', () => {
    const rows = [mk('w1', 'waiting', NOW - 1000), mk('w2', 'waiting', NOW - 2000)]
    const secs = groupRows(rows, NOW)
    expect(secs.map((s) => s.key)).not.toContain('active')
  })
  it('ended/recoverable 分到今天/昨天/本周/更早', () => {
    const rows = [
      mk('today', 'ended', NOW - 2 * 3600000),
      mk('yday', 'ended', NOW - 30 * 3600000),     // 昨天
      mk('week', 'ended', NOW - 4 * DAY),          // 本周
      mk('old', 'recoverable', NOW - 20 * DAY),    // 更早
    ]
    const secs = groupRows(rows, NOW)
    const keys = secs.map((s) => s.key)
    expect(keys).toEqual(['today', 'yesterday', 'week', 'older'])
  })
  it('空组略过', () => {
    const secs = groupRows([mk('r', 'running', NOW)], NOW)
    expect(secs.map((s) => s.key)).toEqual(['today'])
  })
  it('桶内按 lastActive 倒序', () => {
    const rows = [
      mk('a', 'ended', NOW - 5 * 3600000),
      mk('b', 'ended', NOW - 1 * 3600000),
    ]
    const secs = groupRows(rows, NOW)
    expect(secs[0].rows.map((r) => r.id)).toEqual(['b', 'a'])
  })
})

describe('recentCwds — 聚合去重取最近', () => {
  const mk = (id, cwd, ts) => ({ id, cwd, lastActive: ts })
  it('两族聚合、去重、按最近排序', () => {
    const rows = [
      mk('a', '/w/x', NOW - 10000),
      mk('b', '/w/y', NOW - 1000),
      mk('c', '/w/x', NOW - 500),   // 与 a 同目录,更新
      mk('d', '', NOW),             // 空目录忽略
    ]
    expect(recentCwds(rows)).toEqual(['/w/x', '/w/y'])
  })
  it('上限默认 6', () => {
    const rows = []
    for (let i = 0; i < 10; i++) rows.push(mk('s' + i, '/w/' + i, NOW - i))
    expect(recentCwds(rows)).toHaveLength(6)
    expect(recentCwds(rows, 3)).toHaveLength(3)
  })
})

describe('filterRows — 前端搜索', () => {
  const rows = [
    { title: 'Walker 战斗', cwd: '/repo/walker' },
    { title: '配表', cwd: '/repo/igame' },
  ]
  it('按标题匹配', () => { expect(filterRows(rows, 'walker').map((r) => r.title)).toEqual(['Walker 战斗']) })
  it('按 cwd 匹配', () => { expect(filterRows(rows, 'igame').map((r) => r.title)).toEqual(['配表']) })
  it('空查询返回全部', () => { expect(filterRows(rows, '')).toHaveLength(2) })
})

describe('relTime — 相对时间短标', () => {
  it('分级', () => {
    expect(relTime(NOW - 30000, NOW)).toBe('刚刚')
    expect(relTime(NOW - 5 * 60000, NOW)).toBe('5 分钟前')
    expect(relTime(NOW - 3 * 3600000, NOW)).toBe('3 小时前')
    expect(relTime(NOW - 30 * 3600000, NOW)).toBe('昨天')
    expect(relTime(NOW - 4 * DAY, NOW)).toBe('4 天前')
  })
})
