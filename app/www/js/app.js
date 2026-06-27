// app.js — LOFA 移动端外壳主入口。
//   · 连接(健康探测)+ 设置/空态  · 底部 tab 路由(审阅/会话/笔记/项目)
//   · 顶栏返回/刷新  · OTA 自更新横幅
// 各 tab 的业务在各自模块;本文件只管壳与路由,是后续功能的共享地基。

import {
  $, toast, connect, normBase, getSaved, save, hostLabel, showView, setBar,
  curView, isView, doUpdate, DEFAULT_BASE, store,
} from './core.js'
import * as review from './reviewView.js'
import * as chat from './chatView.js'
import * as notes from './notesView.js'
import * as projects from './projectsView.js'

let curTab = 'review'

// ── tab 路由 ────────────────────────────────────────────────────────────────
function setTab(m) {
  curTab = m
  ;['Review', 'Chat', 'Notes', 'Projects'].forEach((t) => {
    const el = $('tab' + t); if (el) el.classList.toggle('active', t.toLowerCase() === m)
  })
  if (m === 'review') review.loadList()
  else if (m === 'chat') chat.loadSessions()
  else if (m === 'notes') notes.loadNotes()
  else if (m === 'projects') projects.loadProjects()
}

// ── 顶栏返回:详情→列表 / 会话→会话列表 ─────────────────────────────────────
function onBack() {
  if (isView('convView')) { chat.backToList() }
  else if (isView('noteDetailView')) { notes.backToList() }
  else if (isView('projectDetailView')) { projects.backToList() }
  else if (isView('detailView')) { setBar(hostLabel()); review.loadList() }
}

// ── 顶栏刷新:按当前视图刷新 ─────────────────────────────────────────────────
function onRefresh() {
  if (!store.base) { connectInit(); return }
  if (isView('convView')) chat.refresh()
  else if (curTab === 'chat') chat.loadSessions()
  else if (curTab === 'review') review.refresh()
  else if (curTab === 'notes') notes.refresh()
  else if (curTab === 'projects') projects.refresh()
}

// ── 连接成功后默认进审阅 tab ────────────────────────────────────────────────
function onConnected() { setTab('review') }
function connectInit() { connect(normBase(getSaved() || DEFAULT_BASE), onConnected) }

// ── 事件接线 ────────────────────────────────────────────────────────────────
function wire() {
  $('btnBack').onclick = onBack
  $('btnRefresh').onclick = onRefresh
  $('btnSettings').onclick = () => { $('host').value = getSaved() || DEFAULT_BASE; showView('settingsView') }
  $('btnConnect').onclick = () => {
    const b = normBase($('host').value)
    if (!b) { $('setStatus').textContent = '请输入地址'; return }
    save(b); connect(b, onConnected)
  }
  $('btnRetry').onclick = connectInit
  $('btnEdit').onclick = () => { $('host').value = getSaved() || DEFAULT_BASE; showView('settingsView') }

  $('tabReview').onclick = () => { if (store.base) setTab('review') }
  $('tabChat').onclick = () => { if (store.base) setTab('chat') }
  $('tabNotes').onclick = () => { if (store.base) setTab('notes') }
  $('tabProjects').onclick = () => { if (store.base) setTab('projects') }

  $('updateBtn').onclick = doUpdate
  $('updateClose').onclick = () => $('updateBanner').classList.remove('show')

  // 会话 tab 自身的内部事件(composer/stop/工具栏/slash 快捷条)
  chat.initChat({ onBack: () => { /* barSub 复位由 backToList 内的 loadSessions 处理 */ } })

  // 笔记 tab 自身的静态控件(搜索框/搜索键/写札记按钮)
  notes.initNotes()
}

// ── 启动 ────────────────────────────────────────────────────────────────────
wire()
connectInit()

// 暴露给手动调试(可选)
window.LOFA = { connect: connectInit, setTab }
