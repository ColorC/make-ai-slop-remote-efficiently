// notesView.js — 笔记 / 代码面板 / 通用网页 三个全屏 iframe 推入页(懒加载 data-url 复用)。
//   笔记 = 经反代的 poof BlockSuite 笔记网页;代码面板 = 主机下发的网页版 VSCode;
//   通用网页 openWeb = 项目双视图的应用/快速入口在 app 内直达(独立 webView 容器,
//   不占 codeView 以免弄丢代码面板已加载状态)。都借外部页面,不占 tab,角上悬浮返回钮。

import { store, toast, fetchCodeConfig, codeUrl } from './core.js'
import { icons } from './ui.js'
import * as router from './router.js'

// URL 归一:相对路径拼 store.base;localhost/127.0.0.1 形式把主机名换成 store.base 的主机名
// (端口/协议保留;服务若只绑本机则可能打不开,不做探测,iframe 失败就失败);其余绝对地址原样。
function resolveWebUrl(url) {
  url = String(url == null ? '' : url).trim()
  if (!url) return ''
  const base = (store.base || '').replace(/\/+$/, '')
  if (url.charAt(0) === '/') return base + url
  const m = url.match(/^(https?:)\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/i)
  if (m) {
    let host = ''
    try { host = new URL(base).hostname } catch (e) { host = base.replace(/^https?:\/\//, '').replace(/[:/].*$/, '') }
    return m[1] + '//' + host + (m[3] || '') + (m[4] || '/')
  }
  return url
}

function ensure(viewId) {
  const view = document.getElementById(viewId)
  if (view.querySelector('iframe')) return view
  view.innerHTML =
    '<button class="float-back" aria-label="返回">' + icons.back + '</button>' +
    '<iframe class="iframe-full" allow="clipboard-read; clipboard-write; fullscreen" referrerpolicy="no-referrer"></iframe>'
  view.querySelector('.float-back').addEventListener('click', () => router.pop())
  return view
}
function lazySrc(view, url) {
  const f = view.querySelector('iframe')
  if (f && url && f.getAttribute('data-url') !== url) { f.src = url; f.setAttribute('data-url', url) }
}

export function openNotes() {
  if (!store.base) { toast('未连接'); return }
  const view = ensure('notesView')
  lazySrc(view, store.base.replace(/\/+$/, '') + '/lofa/overlay/app/notes-web.html')
  router.push('notesView')
}

export async function openCode() {
  if (!store.base) { toast('未连接'); return }
  if (!store.code) await fetchCodeConfig()
  const url = codeUrl()
  if (!url) { toast('主机未下发代码面板配置'); return }
  const view = ensure('codeView')
  lazySrc(view, url)
  router.push('codeView')
}

// 通用网页:项目双视图的应用宫格 / 列表快速入口点击后,在 app 内全屏 iframe 直达。
export function openWeb(url, title) {
  if (!store.base) { toast('未连接'); return }
  const resolved = resolveWebUrl(url)
  if (!resolved) { toast('地址无效'); return }
  const view = ensure('webView')
  const f = view.querySelector('iframe'); if (f && title) f.title = String(title)
  lazySrc(view, resolved)
  router.push('webView')
}
