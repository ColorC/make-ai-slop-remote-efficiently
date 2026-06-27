// @vitest-environment jsdom
// projectsView UI 状态单测 — 真实驱动控制器(DOM + 拦截 fetch), 锁住:
//   · 三页签切换(项目/任务/计划) + 状态徽标渲染
//   · 状态筛选(项目 stale / 计划 archived) · 计划板的项目筛选切换端点
//   · 只读详情(项目工作线+关联计划 / 任务目标章节子目标 / 计划文档摘要)
//   · 接口失败显可重试错误卡, 重试后恢复 · 全程只读(无任何写请求)
// 每例 resetModules 重新 import, 隔离 projectsView 的模块级状态。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const DOM = `
  <div id="btnBack"></div><div id="tabbar"></div><div id="toast"></div>
  <div class="view" id="projectsView">
    <div id="projectsBoards"></div>
    <div id="projectsFilters"></div>
    <div id="projectsList"></div>
  </div>
  <div class="view" id="projectDetailView"><div id="projectDetail"></div></div>
`

const PROJECTS = {
  projects: [
    { id: 'lofa', name: 'LOFA', group: 'omnicompany', pinned: true, plan_count: 2,
      last_active: '2026-06-27T08:00:00+00:00', index_stale: false,
      threads: [{ name: '壳', status: 'active' }, { name: '旧线', status: 'done' }], activity_7d: [false, true] },
    { id: 'stale1', name: '陈旧项目', group: 'other', plan_count: 0,
      last_active: '2026-01-01T00:00:00+00:00', index_stale: true, stale_reason: '久未核对', threads: [] },
  ],
  groups_order: ['omnicompany', 'other'], group_labels: {},
}
const QUESTS = {
  quests: [
    { id: 'lofa', title: 'LOFA', status: 'main', group: 'omnicompany', objective: '远看 omnicompany',
      chapter: '接入项目板', sub_objectives: [{ id: 'p1', title: '计划一', date: '2026-06-27' }], active_plan_count: 1,
      last_active: '2026-06-27T08:00:00+00:00' },
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
// 真后端 get_plan(plans.py) 返回 {id,topic,date,folder_path,files,archived,meta} —— 不含 category。
// 旧 fixture 多带的 category 是前端臆想字段, 已移除(category 只在列表/项目关联端点存在)。
const PLAN_DETAIL = {
  id: 'igame/[2026-06-01]X', topic: 'X', date: '2026-06-01',
  folder_path: 'docs/plans/igame/[2026-06-01]X', archived: false,
  files: [{ path: 'plan.md', is_md: true, summary: '这是计划摘要' }], meta: { status: 'active', work_type: 'planning' },
}

function resp(body, { ok = true, status = 200 } = {}) {
  return {
    ok, status,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

function defaultResponder(url) {
  const u = url.split('?')[0]
  if (u.includes('/api/quests')) return resp(QUESTS)
  if (u.includes('/api/projects/') && u.endsWith('/plans')) return resp(LOFA_PLANS)
  if (/\/api\/plans\/.+/.test(u)) return resp(PLAN_DETAIL)            // 计划详情(带 id)
  if (u.includes('/api/plans')) return resp(PLANS)
  if (u.includes('/api/projects')) return resp(PROJECTS)
  return resp({ ok: true })
}

let calls, responder, projects, core
const $ = (id) => document.getElementById(id)

beforeEach(async () => {
  vi.resetModules()
  document.body.innerHTML = DOM
  calls = []
  responder = defaultResponder
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url), m = (opts.method || 'GET').toUpperCase()
    calls.push({ url: u, method: m })
    if (u.includes('/api/android/log')) return resp({ ok: true })   // 日志回传不参与断言
    return responder(u, m)
  }))
  core = await import('../../../../app/www/js/core.js')
  projects = await import('../../../../app/www/js/projectsView.js')
  core.store.base = 'http://test'
})
afterEach(() => { vi.unstubAllGlobals() })

describe('项目板(默认)', () => {
  it('渲染项目卡片 + 分组/状态徽标; 置顶项目带 📌', async () => {
    await projects.loadProjects()
    const list = $('projectsList')
    expect(list.querySelectorAll('.card').length).toBe(2)
    expect(list.textContent).toContain('LOFA')
    expect(list.textContent).toContain('📌')              // pinned
    expect(list.textContent).toContain('待核对')           // stale 项目状态徽标
    expect(list.querySelector('.b.pst-stale')).toBeTruthy()
    expect(list.textContent).toContain('壳')              // 工作线徽标
  })

  it('状态筛选 待核对 只留 stale 项目', async () => {
    await projects.loadProjects()
    $('projectsFilters').querySelector('.chip.st[data-s="stale"]').click()
    await vi.waitFor(() => {
      const list = $('projectsList')
      expect(list.querySelectorAll('.card').length).toBe(1)
      expect(list.textContent).toContain('陈旧项目')
      expect(list.textContent).not.toContain('LOFA')
    })
  })
})

describe('任务板', () => {
  it('切到任务板 → 主线徽标 + 长期目标', async () => {
    await projects.loadProjects()
    $('projectsBoards').querySelector('.chip[data-b="quests"]').click()
    await vi.waitFor(() => {
      const list = $('projectsList')
      expect(list.querySelector('.b.pst-main')).toBeTruthy()
      expect(list.textContent).toContain('远看 omnicompany')
    })
  })
})

describe('计划板', () => {
  it('切到计划板 → 计划卡片 + 项目筛选 chips(含 LOFA)', async () => {
    await projects.loadProjects()
    $('projectsBoards').querySelector('.chip[data-b="plans"]').click()
    await vi.waitFor(() => {
      expect($('projectsList').querySelectorAll('.card').length).toBe(2)
      expect($('projectsFilters').querySelector('.chip.pj[data-p="lofa"]')).toBeTruthy()
    })
  })

  it('状态筛选 已归档 只留归档计划', async () => {
    await projects.loadProjects()
    $('projectsBoards').querySelector('.chip[data-b="plans"]').click()
    await vi.waitFor(() => expect($('projectsList').querySelectorAll('.card').length).toBe(2))
    $('projectsFilters').querySelector('.chip.st[data-s="archived"]').click()
    await vi.waitFor(() => {
      const list = $('projectsList')
      expect(list.querySelectorAll('.card').length).toBe(1)
      expect(list.textContent).toContain('OLD')
      expect(list.querySelector('.b.pst-archived')).toBeTruthy()
    })
  })

  it('选具体项目 → 走 /api/projects/{id}/plans 端点', async () => {
    await projects.loadProjects()
    $('projectsBoards').querySelector('.chip[data-b="plans"]').click()
    await vi.waitFor(() => expect($('projectsFilters').querySelector('.chip.pj[data-p="lofa"]')).toBeTruthy())
    $('projectsFilters').querySelector('.chip.pj[data-p="lofa"]').click()
    await vi.waitFor(() => {
      expect(calls.some((c) => c.url.includes('/api/projects/lofa/plans'))).toBe(true)
      expect($('projectsList').textContent).toContain('SHELL')
    })
  })
})

describe('只读详情', () => {
  it('计划详情: 文档摘要可见(只读)', async () => {
    await projects.loadProjects()
    $('projectsBoards').querySelector('.chip[data-b="plans"]').click()
    await vi.waitFor(() => expect($('projectsList').querySelector('.card')).toBeTruthy())
    $('projectsList').querySelector('.card').click()
    await vi.waitFor(() => {
      expect($('projectDetailView').classList.contains('show')).toBe(true)
      expect($('projectDetail').textContent).toContain('这是计划摘要')
    })
  })

  it('任务详情: 长期目标/当前章节/子目标可见', async () => {
    await projects.loadProjects()
    $('projectsBoards').querySelector('.chip[data-b="quests"]').click()
    await vi.waitFor(() => expect($('projectsList').querySelector('.card')).toBeTruthy())
    $('projectsList').querySelector('.card').click()
    await vi.waitFor(() => {
      const d = $('projectDetail').textContent
      expect(d).toContain('远看 omnicompany')
      expect(d).toContain('接入项目板')
      expect(d).toContain('计划一')
    })
  })

  it('项目详情: 工作线 + 关联计划(拉 /projects/{id}/plans)', async () => {
    await projects.loadProjects()
    $('projectsList').querySelector('.card').click()    // 第一张=LOFA
    await vi.waitFor(() => {
      expect($('projectDetailView').classList.contains('show')).toBe(true)
      expect($('projectDetail').textContent).toContain('工作线')
      expect($('projectDetail').textContent).toContain('SHELL')   // 关联计划
    })
  })
})

describe('错误重试(不静默空白)', () => {
  it('列表加载失败显示可重试错误卡, 重试后恢复', async () => {
    responder = () => resp({ detail: 'boom' }, { ok: false, status: 500 })
    await projects.loadProjects()
    expect($('projectsList').textContent).toContain('加载失败')
    const btn = $('projectsRetryBtn')
    expect(btn).toBeTruthy()
    responder = defaultResponder
    btn.click()
    await vi.waitFor(() => expect($('projectsList').querySelector('.card')).toBeTruthy())
  })
})

describe('只读护栏', () => {
  it('浏览+筛选+开详情全程零写请求(无 POST/PUT/DELETE)', async () => {
    await projects.loadProjects()
    $('projectsBoards').querySelector('.chip[data-b="quests"]').click()
    await vi.waitFor(() => expect($('projectsList').querySelector('.card')).toBeTruthy())
    $('projectsList').querySelector('.card').click()
    await vi.waitFor(() => expect($('projectDetailView').classList.contains('show')).toBe(true))
    const writes = calls.filter((c) => c.method !== 'GET' && !c.url.includes('/api/android/log'))
    expect(writes).toEqual([])
  })

  it('项目板所有数据请求显式 GET(apiGet 护栏)', async () => {
    await projects.loadProjects()
    const dataCalls = calls.filter((c) => c.url.includes('/api/') && !c.url.includes('/api/android/log'))
    expect(dataCalls.length).toBeGreaterThan(0)
    dataCalls.forEach((c) => expect(c.method).toBe('GET'))
  })
})

describe('顶栏刷新穿透服务端 index 缓存', () => {
  it('首次加载不带 fresh; 点刷新后下一次项目列表带 ?fresh=1(穿透 enrich_projects 的 _INDEX_CACHE)', async () => {
    await projects.loadProjects()
    // 首次加载: /api/projects 不带 fresh
    const first = calls.find((c) => c.url.includes('/api/projects') && !c.url.includes('/plans'))
    expect(first.url).not.toContain('fresh=1')
    calls.length = 0
    projects.refresh()
    await vi.waitFor(() => {
      const r = calls.find((c) => c.url.includes('/api/projects') && !c.url.includes('/plans'))
      expect(r).toBeTruthy()
      expect(r.url).toContain('fresh=1')
    })
    // fresh 只消费一次: 刷新后切板再加载不应再带 fresh
    calls.length = 0
    $('projectsBoards').querySelector('.chip[data-b="quests"]').click()
    await vi.waitFor(() => expect(calls.some((c) => c.url.includes('/api/quests'))).toBe(true))
    const q = calls.find((c) => c.url.includes('/api/quests'))
    expect(q.url).not.toContain('fresh=1')
  })

  it('任务板顶栏刷新带 ?fresh=1(build_quests 同样穿透缓存)', async () => {
    await projects.loadProjects()
    $('projectsBoards').querySelector('.chip[data-b="quests"]').click()
    await vi.waitFor(() => expect($('projectsList').querySelector('.card')).toBeTruthy())
    calls.length = 0
    projects.refresh()
    await vi.waitFor(() => {
      const r = calls.find((c) => c.url.includes('/api/quests'))
      expect(r).toBeTruthy()
      expect(r.url).toContain('fresh=1')
    })
  })
})
