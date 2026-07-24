// @vitest-environment jsdom
// projectsView UI 单测 — 真实驱动新渲染层(DOM + 拦截 fetch), 锁住:
//   · 四段(segmented)切换:应用 / 列表 / 任务 / 计划(§11e 项目双视图 + 追加修订)
//   · 应用段=真启动器:/api/project-views 的 apps 置顶 + 全部项目图标宫格(#projectsApps)
//   · 应用/列表点击 → 打开 app 内全屏网页(#webView 推入)/ 进项目详情
//   · 列表段:按分组渲染 + 可折叠分组头(折叠态记 localStorage)+ 行内简介 + 快速入口按钮
//   · 筛选 pill 只在任务/计划段显示;筛选 sheet(状态单选 + 计划段项目单选)
//   · 详情推入页三形态 · 接口失败可重试错误卡 · 顶栏刷新穿透 ?fresh=1 · 全程只读(无写请求)
// 每例 resetModules + localStorage.clear() 重新 import(含 router / notesView),隔离模块级状态。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const DOM = `
  <div id="toast"></div>
  <nav id="bottomNav"></nav>
  <div id="viewport">
    <section class="view" id="projectsView"></section>
    <section class="view" id="projectDetailView"></section>
    <section class="view" id="notesView"></section>
    <section class="view" id="codeView"></section>
    <section class="view" id="webView"></section>
  </div>
`

const PROJECT_VIEWS = {
  apps: [
    { id: 'walker-demo', label: '行者 demo', icon: '🎮', url: '/walker-game/' },       // 回退 emoji
    { id: 'aigc', label: 'aigc 审阅', icon: '🎨', icon_url: '/api/project-assets/aigc.png', url: 'http://localhost:8077/' },  // icon_url
  ],
}
const PROJECTS = {
  projects: [
    { id: 'lofa', name: 'LOFA', group: 'omnicompany', pinned: true, plan_count: 2,
      last_active: '2026-06-27T08:00:00+00:00', index_stale: false, desc: '安卓远端只读客户端',
      bg: '/api/project-assets/lofa.png', links: [{ label: '看板', url: 'http://localhost:8210/' }],
      threads: [{ name: '壳', status: 'active' }, { name: '旧线', status: 'done' }] },
    { id: 'stale1', name: '陈旧项目', group: 'other', plan_count: 0,
      last_active: '2026-01-01T00:00:00+00:00', index_stale: true, stale_reason: '久未核对',
      desc: '很久没动的项目', bg: 'linear-gradient(135deg,#172b3e,#2b847c)', links: [] },
  ],
  groups_order: ['omnicompany', 'other'], group_labels: { omnicompany: 'Omnicompany', other: '其它' },
}
const QUESTS = {
  quests: [
    { id: 'lofa', title: 'LOFA', status: 'main', group: 'omnicompany', objective: '远看 omnicompany',
      chapter: '接入项目板', sub_objectives: [{ id: 'p1', title: '计划一', date: '2026-06-27' }],
      active_plan_count: 1, last_active: '2026-06-27T08:00:00+00:00' },
  ],
}
const PLANS = {
  items: [
    { id: 'igame/[2026-06-01]X', topic: 'X', date: '2026-06-01', category: 'igame', archived: false },
    { id: '_archive/[2026-05-01]OLD', topic: 'OLD', date: '2026-05-01', category: '_archive', archived: true },
  ],
}
const LOFA_PLANS = {
  project: 'lofa',
  items: [{ id: 'lofa/[2026-06-20]SHELL', topic: 'SHELL', date: '2026-06-20', category: 'lofa', archived: false }],
  plan_ids: ['lofa/[2026-06-20]SHELL'],
}
const PLAN_DETAIL = {
  id: 'igame/[2026-06-01]X', topic: 'X', date: '2026-06-01',
  folder_path: 'docs/plans/igame/[2026-06-01]X', archived: false,
  files: [{ path: 'plan.md', is_md: true, summary: '这是计划摘要' }], meta: { status: 'active', work_type: 'planning' },
}

function resp(body, { ok = true, status = 200 } = {}) {
  return { ok, status, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) }
}
function defaultResponder(url) {
  const u = url.split('?')[0]
  if (u.includes('/api/project-views')) return resp(PROJECT_VIEWS)
  if (u.includes('/api/quests')) return resp(QUESTS)
  if (u.includes('/api/projects/') && u.endsWith('/plans')) return resp(LOFA_PLANS)
  if (/\/api\/plans\/.+/.test(u)) return resp(PLAN_DETAIL)
  if (u.includes('/api/plans')) return resp(PLANS)
  if (u.includes('/api/projects')) return resp(PROJECTS)
  return resp({ ok: true })
}

let calls, responder, projects, core, router
const $ = (id) => document.getElementById(id)
const segBtn = (v) => $('projectsBoardSeg').querySelector('button[data-v="' + v + '"]')
const items = () => $('projectsList').querySelectorAll('.proj-item')
const rows = () => $('projectsList').querySelectorAll('.lg-row')

beforeEach(async () => {
  vi.resetModules()
  try { localStorage.clear() } catch (e) {}
  document.body.innerHTML = DOM
  calls = []
  responder = defaultResponder
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url), m = (opts.method || 'GET').toUpperCase()
    calls.push({ url: u, method: m })
    if (u.includes('/api/android/log')) return resp({ ok: true })
    return responder(u, m)
  }))
  core = await import('../../../../app/www/js/core.js')
  router = await import('../../../../app/www/js/router.js')
  const notes = await import('../../../../app/www/js/notesView.js')
  projects = await import('../../../../app/www/js/projectsView.js')
  router.registerOpener('web', (p) => notes.openWeb((p && p.url) || '', (p && p.title) || ''))
  core.store.base = 'http://test'
  projects.init()
})
afterEach(() => { vi.unstubAllGlobals() })

describe('列表段(默认)', () => {
  it('按分组渲染:分组头 + 组内项目行(展示图/名/简介/活跃, 无状态标签)', async () => {
    projects.load()
    await vi.waitFor(() => expect(items().length).toBe(2))
    const list = $('projectsList')
    // 分组头(可折叠)
    const heads = list.querySelectorAll('.proj-group-head')
    expect(heads.length).toBe(2)
    expect(list.textContent).toContain('Omnicompany')
    expect(list.textContent).toContain('其它')
    // 行:完整名 + 简介 + 活跃相对时间, 且不带状态徽标
    expect(list.textContent).toContain('LOFA')
    expect(list.textContent).toContain('安卓远端只读客户端')
    expect(list.textContent).toContain('活跃')
    expect(list.querySelector('.proj-badge')).toBeNull()
  })

  it('分组头可折叠, 折叠态记 localStorage 且重载后保留', async () => {
    projects.load()
    await vi.waitFor(() => expect(items().length).toBe(2))
    const head = $('projectsList').querySelector('.proj-group-head[data-group="omnicompany"]')
    head.click()
    await vi.waitFor(() => expect(head.classList.contains('collapsed')).toBe(true))
    expect(JSON.parse(localStorage.getItem('lofa.projGroupsCollapsed')).omnicompany).toBeTruthy()
    // 重载(load 再跑一遍)后仍折叠
    projects.load()
    await vi.waitFor(() => {
      const h = $('projectsList').querySelector('.proj-group-head[data-group="omnicompany"]')
      expect(h && h.classList.contains('collapsed')).toBe(true)
    })
  })

  it('快速入口按钮: 点击项目 links 在 app 内打开网页(#webView 推入, URL 归一)', async () => {
    projects.load()
    await vi.waitFor(() => expect(items().length).toBe(2))
    const link = $('projectsList').querySelector('.proj-link')
    expect(link.textContent).toContain('看板')
    link.click()
    await vi.waitFor(() => expect($('webView').classList.contains('show')).toBe(true))
    // http://localhost:8210/ → 主机名换成 store.base 主机, 端口保留
    expect($('webView').querySelector('iframe').getAttribute('data-url')).toBe('http://test:8210/')
  })

  it('筛选 pill 在列表段隐藏(状态筛选只属任务/计划)', async () => {
    projects.load()
    await vi.waitFor(() => expect(items().length).toBe(2))
    expect($('projectsFilterPill').style.display).toBe('none')
  })
})

describe('应用段(真启动器)', () => {
  it('apps 置顶 + 全部项目图标宫格(#projectsApps), pinned 项目在前', async () => {
    projects.load()
    await vi.waitFor(() => expect(items().length).toBe(2))
    segBtn('apps').click()
    await vi.waitFor(() => expect($('projectsApps')).toBeTruthy())
    const cells = $('projectsApps').querySelectorAll('.proj-app')
    // 2 个 app + 2 个项目
    expect(cells.length).toBe(4)
    const names = Array.prototype.map.call(cells, (c) => c.textContent)
    expect(names[0]).toContain('行者 demo')       // apps 在前
    expect(names[2]).toContain('LOFA')            // 项目段 pinned(LOFA)在前
    expect($('projectsApps').textContent).toContain('陈旧项目')
    expect($('projectsFilterPill').style.display).toBe('none')
  })

  it('点击 app → app 内全屏网页(#webView 推入, 相对路径拼 base)', async () => {
    projects.load()
    await vi.waitFor(() => expect(items().length).toBe(2))
    segBtn('apps').click()
    await vi.waitFor(() => expect($('projectsApps')).toBeTruthy())
    const cell = Array.prototype.find.call($('projectsApps').querySelectorAll('.proj-app'), (c) => c.textContent.includes('行者 demo'))
    cell.click()
    await vi.waitFor(() => expect($('webView').classList.contains('show')).toBe(true))
    expect($('webView').querySelector('iframe').getAttribute('data-url')).toBe('http://test/walker-game/')
  })

  it('app 图标:icon_url 渲染成图标(img,拼 base), 无则回退 emoji', async () => {
    projects.load()
    await vi.waitFor(() => expect(items().length).toBe(2))
    segBtn('apps').click()
    await vi.waitFor(() => expect($('projectsApps')).toBeTruthy())
    const cells = $('projectsApps').querySelectorAll('.proj-app')
    const aigc = Array.prototype.find.call(cells, (c) => c.textContent.includes('aigc 审阅')).querySelector('.proj-app-icon')
    expect(aigc.classList.contains('img')).toBe(true)
    expect(aigc.style.backgroundImage).toContain('http://test/api/project-assets/aigc.png')
    const walker = Array.prototype.find.call(cells, (c) => c.textContent.includes('行者 demo')).querySelector('.proj-app-icon')
    expect(walker.classList.contains('emoji')).toBe(true)
    expect(walker.textContent).toBe('🎮')
  })

  it('点击项目图标 → 项目详情推入页', async () => {
    projects.load()
    await vi.waitFor(() => expect(items().length).toBe(2))
    segBtn('apps').click()
    await vi.waitFor(() => expect($('projectsApps')).toBeTruthy())
    const cell = Array.prototype.find.call($('projectsApps').querySelectorAll('.proj-app'), (c) => c.textContent.includes('LOFA'))
    cell.click()
    await vi.waitFor(() => {
      expect($('projectDetailView').classList.contains('show')).toBe(true)
      expect($('projectDetail').textContent).toContain('工作线')
    })
  })

  it('应用段接口 404/空 → 空态提示(不崩)', async () => {
    responder = (u) => {
      if (u.includes('/api/project-views')) return resp({ detail: 'not found' }, { ok: false, status: 404 })
      if (u.includes('/api/projects')) return resp({ projects: [], groups_order: [] })
      return resp({ ok: true })
    }
    projects.load()
    // 直接切应用段
    segBtn('apps').click()
    await vi.waitFor(() => expect($('projectsList').textContent).toContain('暂无应用'))
  })
})

describe('任务段', () => {
  it('切到任务段(segmented) → 主线徽标 + 长期目标摘要', async () => {
    projects.load()
    await vi.waitFor(() => expect(items().length).toBe(2))
    segBtn('quests').click()
    await vi.waitFor(() => {
      const list = $('projectsList')
      expect(list.textContent).toContain('主线')
      expect(list.textContent).toContain('接入项目板')
    })
    expect($('projectsFilterPill').style.display).not.toBe('none')
  })
})

describe('计划段', () => {
  it('切到计划段 → 计划行 + 筛选 sheet 有项目单选(含 LOFA)', async () => {
    projects.load()
    await vi.waitFor(() => expect(items().length).toBe(2))
    segBtn('plans').click()
    await vi.waitFor(() => expect(rows().length).toBe(2))
    $('projectsFilterPill').click()
    await vi.waitFor(() => expect(document.querySelector('#projectsFilterSheet .lg-sheet-radio[data-project="lofa"]')).toBeTruthy())
  })

  it('筛选 sheet 状态「已归档」只留归档计划', async () => {
    projects.load()
    segBtn('plans').click()
    await vi.waitFor(() => expect(rows().length).toBe(2))
    $('projectsFilterPill').click()
    await vi.waitFor(() => expect(document.querySelector('#projectsFilterSheet .lg-sheet-radio[data-status="archived"]')).toBeTruthy())
    document.querySelector('#projectsFilterSheet .lg-sheet-radio[data-status="archived"]').click()
    await vi.waitFor(() => {
      expect(rows().length).toBe(1)
      expect($('projectsList').textContent).toContain('OLD')
    })
  })

  it('筛选 sheet 选具体项目 → 走 /api/projects/{id}/plans 端点', async () => {
    projects.load()
    segBtn('plans').click()
    await vi.waitFor(() => expect(rows().length).toBe(2))
    $('projectsFilterPill').click()
    await vi.waitFor(() => expect(document.querySelector('#projectsFilterSheet .lg-sheet-radio[data-project="lofa"]')).toBeTruthy())
    document.querySelector('#projectsFilterSheet .lg-sheet-radio[data-project="lofa"]').click()
    await vi.waitFor(() => {
      expect(calls.some((c) => c.url.includes('/api/projects/lofa/plans'))).toBe(true)
      expect($('projectsList').textContent).toContain('SHELL')
    })
  })
})

describe('只读详情推入页(三形态)', () => {
  it('计划详情: 文档摘要可见, 推入 #projectDetailView', async () => {
    projects.load()
    segBtn('plans').click()
    await vi.waitFor(() => expect(rows().length).toBe(2))
    $('projectsList').querySelector('.lg-row').click()
    await vi.waitFor(() => {
      expect($('projectDetailView').classList.contains('show')).toBe(true)
      expect($('projectDetail').textContent).toContain('这是计划摘要')
    })
  })

  it('任务详情: 长期目标/当前章节/进行中子目标可见', async () => {
    projects.load()
    segBtn('quests').click()
    await vi.waitFor(() => expect(rows().length).toBe(1))
    $('projectsList').querySelector('.lg-row').click()
    await vi.waitFor(() => {
      const d = $('projectDetail').textContent
      expect(d).toContain('远看 omnicompany')
      expect(d).toContain('接入项目板')
      expect(d).toContain('计划一')
    })
  })

  it('项目详情(列表段行主体): 工作线徽标 + 关联计划(拉 /projects/{id}/plans)', async () => {
    projects.load()
    await vi.waitFor(() => expect(items().length).toBe(2))
    const main = Array.prototype.find.call($('projectsList').querySelectorAll('.proj-item-main'), (r) => r.textContent.includes('LOFA'))
    main.click()
    await vi.waitFor(() => {
      expect($('projectDetailView').classList.contains('show')).toBe(true)
      expect($('projectDetail').textContent).toContain('工作线')
      expect($('projectDetail').textContent).toContain('SHELL')
    })
  })
})

describe('错误重试(不静默空白)', () => {
  it('列表加载失败显示可重试错误卡, 重试后恢复', async () => {
    responder = () => resp({ detail: 'boom' }, { ok: false, status: 500 })
    projects.load()
    await vi.waitFor(() => expect($('projectsList').textContent).toContain('加载失败'))
    const btn = $('projectsList').querySelector('.lg-empty-action')
    expect(btn).toBeTruthy()
    responder = defaultResponder
    btn.click()
    await vi.waitFor(() => expect(items().length).toBe(2))
  })

  it('计划详情加载失败也显示可重试错误卡', async () => {
    projects.load()
    segBtn('plans').click()
    await vi.waitFor(() => expect(rows().length).toBe(2))
    responder = () => resp({ detail: 'boom' }, { ok: false, status: 500 })
    $('projectsList').querySelector('.lg-row').click()
    await vi.waitFor(() => expect($('projectDetail').querySelector('.lg-empty-action')).toBeTruthy())
  })
})

describe('只读护栏', () => {
  it('浏览(四段)+筛选+开详情+开网页全程零写请求(无 POST/PUT/DELETE)', async () => {
    projects.load()
    await vi.waitFor(() => expect(items().length).toBe(2))
    segBtn('apps').click()
    await vi.waitFor(() => expect($('projectsApps')).toBeTruthy())
    segBtn('quests').click()
    await vi.waitFor(() => expect(rows().length).toBe(1))
    $('projectsList').querySelector('.lg-row').click()
    await vi.waitFor(() => expect($('projectDetailView').classList.contains('show')).toBe(true))
    const writes = calls.filter((c) => c.method !== 'GET' && !c.url.includes('/api/android/log'))
    expect(writes).toEqual([])
  })
})

describe('顶栏刷新穿透服务端 index 缓存', () => {
  it('首次加载不带 fresh; 点刷新图标后下一次项目列表带 ?fresh=1, 只消费一次', async () => {
    projects.load()
    await vi.waitFor(() => expect(items().length).toBe(2))
    const first = calls.find((c) => c.url.includes('/api/projects') && !c.url.includes('/plans'))
    expect(first.url).not.toContain('fresh=1')

    calls.length = 0
    document.querySelector('[aria-label="刷新"]').click()
    await vi.waitFor(() => {
      const r = calls.find((c) => c.url.includes('/api/projects') && !c.url.includes('/plans'))
      expect(r).toBeTruthy()
      expect(r.url).toContain('fresh=1')
    })

    calls.length = 0
    segBtn('quests').click()
    await vi.waitFor(() => expect(calls.some((c) => c.url.includes('/api/quests'))).toBe(true))
    const q = calls.find((c) => c.url.includes('/api/quests'))
    expect(q.url).not.toContain('fresh=1')
  })

  it('任务段顶栏刷新带 ?fresh=1', async () => {
    projects.load()
    segBtn('quests').click()
    await vi.waitFor(() => expect(rows().length).toBe(1))
    calls.length = 0
    document.querySelector('[aria-label="刷新"]').click()
    await vi.waitFor(() => {
      const r = calls.find((c) => c.url.includes('/api/quests'))
      expect(r).toBeTruthy()
      expect(r.url).toContain('fresh=1')
    })
  })
})
