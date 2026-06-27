// projectsState.js — 项目 tab 的纯函数适配层(无 DOM, node 可单测)。
//
// 把电脑端「项目工作板 / 任务窗口 / 计划目录」三套只读端点归一成
// 「卡片 + 状态徽标 + 筛选」模型, 让 projectsView 只管 DOM。对齐已核实后端:
//   项目  GET /api/projects            → enrich_projects(): {projects[], groups_order, group_labels}
//   任务  GET /api/quests              → build_quests():    {quests[]}(进行中项目=长期任务卡)
//   计划  GET /api/plans               → {items[{id,topic,date,category,archived,title_zh,...}]}
//        GET /api/projects/{id}/plans  → {project, items[{id,topic,title_zh,date,category,archived}], plan_ids}
//
// 进度真源概念上是 whatnow(:8230, 未经 dashboard 代理), 手机端只展示这三个端点
// 给出的状态/进度, 不写状态(只读)。设计成纯函数, 让"端点选择 / 状态徽标 / 筛选 /
// 卡片归一"都能被 Vitest 锁住。

// ── 工作板(项目 tab 内部三页签) ──────────────────────────────────────────────
export const BOARDS = [
  { value: 'projects', label: '项目' },
  { value: 'quests', label: '任务' },
  { value: 'plans', label: '计划' },
]
export const DEFAULT_BOARD = 'projects'
export function isBoard(v) { return BOARDS.some((b) => b.value === v) }

// ── 状态筛选项(按工作板, 对齐电脑端状态语义) ────────────────────────────────
//   项目: index 久未核对 → 待核对(stale), 否则 活跃; 任务: 主线/支线; 计划: 进行中/已归档。
export const STATUS_FILTERS = {
  projects: [['', '全部'], ['active', '活跃'], ['stale', '待核对']],
  quests: [['', '全部'], ['main', '主线'], ['side', '支线']],
  plans: [['', '全部'], ['active', '进行中'], ['archived', '已归档']],
}
export function statusFilters(board) { return STATUS_FILTERS[board] || STATUS_FILTERS.projects }

// ── 状态徽标映射(label + css class, 对齐电脑端配色语义) ──────────────────────
// 工作线: active=进行中(绿) done=已完成(灰) blocked=受阻(红) parked=搁置(暗)
// 任务: main=主线(金) side=支线(灰); 计划: archived=已归档(琥珀) active=进行中(绿)
// 项目级聚合: stale=待核对(琥珀) active=活跃(绿)。
const STATUS_LABELS = {
  active: '进行中', done: '已完成', blocked: '受阻', parked: '搁置',
  main: '主线', side: '支线', archived: '已归档', stale: '待核对',
}
export function statusMeta(status) {
  const key = String(status == null ? '' : status).trim().toLowerCase()
  const known = Object.prototype.hasOwnProperty.call(STATUS_LABELS, key)
  return {
    key,
    label: known ? STATUS_LABELS[key] : (status == null ? '' : String(status)),
    cls: known ? 'pst-' + key : 'pst-unknown',
  }
}

// ── 小工具 ──────────────────────────────────────────────────────────────────
// plan id 是 docs/plans 下相对路径(如 igame/figma-to-prefab/[2026-06-01]X);分段编码保留斜杠,
// 否则打不到 {plan_id:path} 路由(与 notesState.encPath 同理)。
export function encPath(id) {
  return String(id == null ? '' : id).split('/').map(encodeURIComponent).join('/')
}
export function shortTime(iso) {
  if (!iso) return ''
  return String(iso).replace('T', ' ').slice(0, 16)
}

// ── 端点选择(筛选逻辑核心, 单测锁定) ────────────────────────────────────────
// fresh=用户点刷新 → ?fresh=1 穿透服务端 index 解析缓存(项目/任务板)。
// 计划板选中具体项目时走 /api/projects/{id}/plans(服务端归属), 否则走全量 /api/plans。
export function listPath(board, opts) {
  opts = opts || {}
  if (board === 'quests') return '/api/quests' + (opts.fresh ? '?fresh=1' : '')
  if (board === 'plans') {
    if (opts.project) return '/api/projects/' + encodeURIComponent(opts.project) + '/plans'
    return '/api/plans'
  }
  return '/api/projects' + (opts.fresh ? '?fresh=1' : '')
}
export function planDetailPath(id) { return '/api/plans/' + encPath(id) }
export function projectPlansPath(id) { return '/api/projects/' + encodeURIComponent(id) + '/plans' }

// 各端点的列表数组在响应里的位置不同(projects/quests/items), 集中归一。
export function extractItems(board, data) {
  data = data || {}
  if (board === 'quests') return data.quests || []
  if (board === 'plans') return data.items || []
  return data.projects || []
}

// 计划板的「项目」筛选选项 —— 从 /api/projects 响应派生(全部 + 各项目)。
export function projectFilterOptions(projectsData) {
  const projs = extractItems('projects', projectsData)
  return [{ id: '', name: '全部项目' }].concat(
    projs.map((p) => ({ id: p.id, name: p.name || p.id })),
  )
}

// ── 后端原始项 → 统一卡片(列表渲染消费) ─────────────────────────────────────

export function projectCard(p) {
  p = p || {}
  return {
    board: 'projects',
    id: p.id,
    title: p.name || p.id,
    group: p.group || '',
    pinned: !!p.pinned,
    planCount: p.plan_count || 0,
    lastActive: p.last_active || p.updated_at || null,
    stale: !!p.index_stale,
    staleReason: p.stale_reason || '',
    threads: Array.isArray(p.threads) ? p.threads : [],
    activity7d: Array.isArray(p.activity_7d) ? p.activity_7d : [],
    // 项目级聚合状态(供 status 筛选): index 久未核对 → 待核对, 否则 活跃。
    status: p.index_stale ? 'stale' : 'active',
  }
}

export function questCard(q) {
  q = q || {}
  return {
    board: 'quests',
    id: q.id,
    title: q.title || q.id,
    group: q.group || '',
    status: q.status || 'side',   // main / side(或 quest steward 覆盖值)
    objective: q.objective || '',
    chapter: q.chapter || '',
    sub: Array.isArray(q.sub_objectives) ? q.sub_objectives : [],
    activePlanCount: q.active_plan_count || 0,
    lastActive: q.last_active || null,
    activity7d: Array.isArray(q.activity_7d) ? q.activity_7d : [],
  }
}

export function planCard(it) {
  it = it || {}
  const archived = !!it.archived
  const date = it.date || ''
  const topic = it.topic || ''
  // 标题优先治理部门中文标题, 退回 [日期]主题; 末了退回 id。
  const title = it.title_zh || (date && topic ? date + ' ' + topic : topic) || it.id
  return {
    board: 'plans',
    id: it.id,
    title,
    topic,
    date,
    category: it.category || '',
    archived,
    status: archived ? 'archived' : 'active',
  }
}

export function normalizeCards(board, items) {
  const fn = board === 'quests' ? questCard : board === 'plans' ? planCard : projectCard
  return (items || []).map(fn)
}

// ── 客户端筛选(状态) ────────────────────────────────────────────────────────
// project/计划的端点级筛选靠 listPath(选项目走 /projects/{id}/plans);状态在客户端过滤。
export function filterByStatus(cards, status) {
  if (!status) return cards || []
  return (cards || []).filter((c) => c && c.status === status)
}
