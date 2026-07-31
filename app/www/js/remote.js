// remote.js — B 档反向控制(做进 APP)。
//
// 即使 LOFA 只能**单向**连本机(飞连: 手机→本机可达, 本机够不着手机的 adb),
// 本机仍能驱动它: app 定时轮询本机的「待办命令」→ 在自己进程内执行 → 回传结果。
// 这是「无反向 adb」时的远程操作/调试通道。命令信道在 dashboard(/api/android/commands/*)。
//
// 能做(app 自助): OTA 装新包 / 切 tab / 在 app 内点击导航 / 回传状态·DOM / eval 调试 / 弹提示。
// 做不到(无系统权限): 系统级任意点击、装别的 app、底层调试 —— 那些要 A 档(adb/模拟器)。

import { api, apiJson, toast, store, checkUpdate, doUpdate, LOG } from './core.js'
import * as router from './router.js'
import { automationControlBase } from './remoteState.js'

const DID_KEY = 'lofa.deviceId'
export function deviceId() {
  let id = ''
  try { id = localStorage.getItem(DID_KEY) || '' } catch (e) {}
  if (!id) {
    id = 'lofa-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
    try { localStorage.setItem(DID_KEY, id) } catch (e) {}
  }
  return id
}

let _timer = null

async function execCommand(cmd) {
  const op = cmd.op
  const args = cmd.args || {}
  switch (op) {
    case 'ping':
      return { pong: true, at: Date.now() }
    case 'toast':
      toast(String(args.msg || '(本机远程消息)'))
      return { shown: true, msg: args.msg }
    case 'navigate': {
      // 走新导航 API:args.tab=tab 名(sessions/review/projects/me),或 args.session/args.review 深链。
      if (args.session) { router.open('session', String(args.session)); return { navigated: 'session:' + args.session, view: router.current() } }
      if (args.review) { router.open('review', String(args.review)); return { navigated: 'review:' + args.review, view: router.current() } }
      const tab = String(args.tab || 'sessions')
      const ok = router.open(tab)
      if (ok === false) return { error: 'no_tab:' + tab }
      return { navigated: tab, view: router.current() }
    }
    case 'state':
      return {
        view: router.current(), base: store.base, deviceId: deviceId(),
        title: document.title, ua: (navigator.userAgent || '').slice(0, 80),
      }
    case 'screenshot':
      // 整屏截图需 Android MediaProjection(原生, 见 plan B 档第二步);
      // app 内先轻量回传 WebView 自身状态+可见文本, 供本机远程"看一眼"。
      return { kind: 'webview-state', view: router.current(), bodyText: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 600) }
    case 'ota_check':
      await checkUpdate()
      return { checked: true }
    case 'ota_install':
      await doUpdate()
      return { started: true }
    default:
      return { error: 'unknown_op:' + op }
  }
}

async function poll() {
  if (!store.base) return
  let cmds = []
  try {
    const d = await api('/api/android/commands/poll?device_id=' + encodeURIComponent(deviceId()))
    cmds = (d && d.commands) || []
  } catch (e) { return }
  for (const cmd of cmds) {
    let ok = true
    let result = null
    try { result = await execCommand(cmd) } catch (e) { ok = false; result = { error: String(e && e.message || e) } }
    if (result && result.error) ok = false
    try {
      await apiJson('/api/android/commands/result', 'POST',
        { device_id: deviceId(), command_id: cmd.id, ok, result })
    } catch (e) {}
    LOG.rec('info', ['remote.exec', cmd.op, ok])
  }
}

// 连接成功后启动: 先登记(带 device_id, 让本机知道这台在线), 再起轮询。
export async function startRemote() {
  if (_timer) return
  const A = window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.DeviceAutomation
  if (A) {
    try {
      const controlBase = automationControlBase(store.base)
      const result = await A.configure({ baseUrl: controlBase, deviceId: deviceId() })
      LOG.rec('info', ['device-automation.configure', controlBase, result])
    } catch (e) {
      LOG.rec('error', ['device-automation.configure.fail', e.message || e])
      throw e
    }
  }
  try { await apiJson('/api/android/register', 'POST', { device_id: deviceId() }) } catch (e) {}
  poll()
  _timer = setInterval(poll, 3000)
  LOG.rec('info', ['remote.start', deviceId()])
}
export function stopRemote() { if (_timer) { clearInterval(_timer); _timer = null } }
