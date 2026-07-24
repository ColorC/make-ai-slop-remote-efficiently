// router.js — 视图栈路由。
//   tab(name) 切根页 · push/pop 推入弹出(右滑转场)· back() 统一返回 · open(kind,payload) 深链
//   底 tab 显隐 / 转场 / ≥840 审阅双栏 split 全由本模块统一管。视图容器 id 见 index.html。
// view 之间零相互 import;导航一律经此。

import { closeTopLayer } from './ui.js'

const S = {
  tabs: {},            // name → rootViewId
  defaultTab: null,
  tab: null,           // 当前 tab name
  stack: [],           // 视图 id 栈:底=当前 tab 根,其上为推入页
  split: null,         // ≥600 主从分栏中的 detail viewId(否则 null)
}
const openers = {}
const changeCbs = []
// 主从分栏:detail viewId → master viewId(≥600 时同屏,不推入)
const SPLIT_PAIRS = { reviewDetailView: 'reviewView', projectDetailView: 'projectsView' }

// split 判定走 matchMedia 监听(禁 innerWidth 快照 / resize 监听):跨 840 时做单栏↔双栏换算,
// 旋转屏幕(port↔land)形态自洽。阈值与 base.css 的 @media (min-width:840px) 同源。
const splitMq = (typeof matchMedia === 'function') ? matchMedia('(min-width: 840px)') : null
function splitOn() { return !!(splitMq && splitMq.matches) }

const el = (id) => document.getElementById(id)
const nav = () => el('bottomNav')
function reducedMotion() {
  if (document.documentElement.classList.contains('reduce-motion')) return true
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}
function allViews() { return Array.prototype.slice.call(document.querySelectorAll('#viewport > .view')) }
export function current() { return S.stack[S.stack.length - 1] }
function notify() { const p = { tab: S.tab, view: current() }; changeCbs.forEach((cb) => { try { cb(p) } catch (e) {} }) }

function updateNav() {
  const atRoot = S.stack.length === 1 || !!S.split
  const n = nav(); if (n) n.classList.toggle('show', atRoot && !!S.tab)
  document.querySelectorAll('#bottomNav .lg-tab').forEach((b) => b.classList.toggle('on', b.getAttribute('data-tab') === S.tab))
}

export function init(opts) {
  opts = opts || {}
  S.tabs = opts.tabs || {}
  S.defaultTab = opts.defaultTab || Object.keys(S.tabs)[0]
  document.querySelectorAll('#bottomNav .lg-tab').forEach((b) => {
    b.addEventListener('click', () => tab(b.getAttribute('data-tab')))
  })
  tab(S.defaultTab)
}

// 切 tab:回该 tab 根页(视图为单例,不保留 per-tab 推入栈)。同 tab 再点=归根。
export function tab(name) {
  if (!S.tabs[name]) return
  const root = S.tabs[name]
  // 收起分栏与所有推入/显示态,只显根
  S.split = null; document.body.classList.remove('split-active')
  allViews().forEach((v) => v.classList.remove('show', 'anim-in', 'anim-out'))
  S.tab = name; S.stack = [root]
  const r = el(root); if (r) r.classList.add('show')
  updateNav(); notify()
}

export function push(viewId) {
  if (!viewId || viewId === current()) return
  const cur = current()
  // ≥600 主从分栏:审阅/项目详情与其列表同屏,不走推入转场
  if (splitOn() && SPLIT_PAIRS[viewId] && SPLIT_PAIRS[viewId] === cur) {
    S.split = viewId; S.stack.push(viewId)
    document.body.classList.add('split-active')
    const d = el(viewId); if (d) d.classList.add('show')
    updateNav(); notify(); return
  }
  S.stack.push(viewId)
  const e = el(viewId); if (!e) return
  e.classList.add('show')
  // 推入完成(或瞬切)后隐藏前一页;若动画中途旋入 split 且前一页正是分栏 master,保留同屏
  const hideCur = () => { if (cur && !(S.split && SPLIT_PAIRS[S.split] === cur)) el(cur).classList.remove('show') }
  if (reducedMotion()) hideCur()
  else {
    e.classList.add('anim-in')
    e.addEventListener('animationend', function h() {
      e.classList.remove('anim-in'); e.removeEventListener('animationend', h)
      hideCur()
    }, { once: true })
  }
  updateNav(); notify()
}

export function pop() {
  if (S.stack.length <= 1) return false
  const top = S.stack.pop()
  const under = current()
  if (S.split === top) {
    S.split = null; document.body.classList.remove('split-active')
    const d = el(top); if (d) d.classList.remove('show')
    updateNav(); notify(); return true
  }
  const u = el(under); if (u) u.classList.add('show')
  const e = el(top)
  if (!e) { updateNav(); notify(); return true }
  if (reducedMotion()) { e.classList.remove('show') }
  else {
    e.classList.add('anim-out')
    e.addEventListener('animationend', function h() { e.classList.remove('anim-out', 'show'); e.removeEventListener('animationend', h) }, { once: true })
  }
  updateNav(); notify(); return true
}

// 统一返回:关最上层浮层 → pop 推入页 → 非默认 tab 回默认 tab → 都不成返回 false(调用方 minimize)。
export function back() {
  if (closeTopLayer()) return true
  if (S.stack.length > 1) { pop(); return true }
  if (S.tab !== S.defaultTab) { tab(S.defaultTab); return true }
  return false
}

// ── 跨断点形态换算(旋转 port↔land 自洽的核心) ──
//   进入 split(窄→宽):栈顶 detail 且其下正是其 master → 同屏双栏(master 回 .show)
//   退出 split(宽→窄):同屏 detail → 单栏推入态(master 收 .show,detail 独占全屏)
// 栈本身不动,返回链语义不变:split 态 pop=收起 detail;单栏态 pop=滑出回退。
// 不 notify:视图栈未变,仅呈现形态变,避免触发各 view 重拉数据。
function onSplitMqChange() {
  if (splitOn()) {
    const top = current()
    if (top && SPLIT_PAIRS[top] && S.stack[S.stack.length - 2] === SPLIT_PAIRS[top]) {
      S.split = top
      document.body.classList.add('split-active')
      const m = el(SPLIT_PAIRS[top]); if (m) m.classList.add('show')
      const d = el(top); if (d) { d.classList.add('show'); d.classList.remove('anim-in', 'anim-out') }
      updateNav()
    }
  } else if (S.split) {
    const m = el(SPLIT_PAIRS[S.split])
    S.split = null
    document.body.classList.remove('split-active')
    if (m) m.classList.remove('show')   // 单栏只露栈顶 detail,master 待 pop 时回显
    updateNav()
  }
}
if (splitMq) {
  if (typeof splitMq.addEventListener === 'function') splitMq.addEventListener('change', onSplitMqChange)
  else if (typeof splitMq.addListener === 'function') splitMq.addListener(onSplitMqChange)   // 旧 WebView 兜底
}

// 深链 / 通知点击 / remote.navigate 共用。kind=已注册 opener 名或 tab 名,或 'session:<id>' 形式。
export function open(kind, payload) {
  if (openers[kind]) return openers[kind](payload)
  if (S.tabs[kind]) return tab(kind)
  const m = String(kind || '').match(/^([\w-]+):(.+)$/)
  if (m && openers[m[1]]) return openers[m[1]](m[2])
  return false
}
export function registerOpener(kind, fn) { openers[kind] = fn }
export function onChange(cb) { if (typeof cb === 'function') changeCbs.push(cb) }

// 底 tab 角标(审阅未读 / 我的 有更新)
export function setBadge(name, n) {
  const d = document.querySelector('#bottomNav .lg-tab-dot[data-badge="' + name + '"]')
  if (!d) return
  if (n) { d.textContent = (typeof n === 'number' && n > 0) ? String(n) : ''; d.classList.add('show') }
  else d.classList.remove('show')
}
