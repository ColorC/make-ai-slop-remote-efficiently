// Compatibility polling channel for older controllers. It exposes shell
// diagnostics, OTA and Dashboard deep-link navigation only. There is no generic
// plugin dispatch and no local business renderer behind this channel.
import { api, apiJson, toast, store, checkUpdate, doUpdate, LOG } from './core.js'
import * as router from './router.js'
import { automationControlBase } from './remoteState.js'

const DEVICE_ID_KEY = 'lofa.deviceId'
export function deviceId() {
  let value = ''
  try { value = localStorage.getItem(DEVICE_ID_KEY) || '' } catch (error) {}
  if (!value) {
    value = 'lofa-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
    try { localStorage.setItem(DEVICE_ID_KEY, value) } catch (error) {}
  }
  return value
}

let timer = null

async function execute(command) {
  const operation = command.op
  const args = command.args || {}
  switch (operation) {
    case 'ping':
      return { pong: true, at: Date.now() }
    case 'toast':
      toast(String(args.msg || '远程消息'))
      return { shown: true }
    case 'navigate': {
      if (args.session) return { opened: await router.open('session', String(args.session)) }
      if (args.review) return { opened: await router.open('review', String(args.review)) }
      return { opened: await router.open(String(args.tab || 'sessions')) }
    }
    case 'state':
      return {
        view: router.current(),
        base: store.base,
        deviceId: deviceId(),
        dashboardBuild: document.documentElement.dataset.lofaFrontendBuild || '',
      }
    case 'screenshot':
      return {
        kind: 'shell-state',
        view: router.current(),
        bodyText: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 600),
      }
    case 'ota_check':
      await checkUpdate()
      return { checked: true }
    case 'ota_install':
      await doUpdate()
      return { started: true }
    default:
      return { error: 'unknown_op:' + operation }
  }
}

async function poll() {
  if (!store.base) return
  let commands = []
  try {
    const response = await api('/api/android/commands/poll?device_id=' + encodeURIComponent(deviceId()))
    commands = response && response.commands || []
  } catch (error) { return }
  for (const command of commands) {
    let ok = true
    let result
    try { result = await execute(command) }
    catch (error) { ok = false; result = { error: String(error && error.message || error) } }
    if (result && result.error) ok = false
    try {
      await apiJson('/api/android/commands/result', 'POST', {
        device_id: deviceId(), command_id: command.id, ok, result,
      })
    } catch (error) {}
    LOG.rec('info', ['remote.execute', operationName(command), ok])
  }
}

function operationName(command) { return command && command.op || '' }

export async function startRemote() {
  if (timer) return
  const automation = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.DeviceAutomation
  if (automation) {
    const controlBase = automationControlBase(store.base)
    const result = await automation.configure({ baseUrl: controlBase, deviceId: deviceId() })
    LOG.rec('info', ['device-automation.configure', controlBase, result])
  }
  try { await apiJson('/api/android/register', 'POST', { device_id: deviceId() }) } catch (error) {}
  poll()
  timer = setInterval(poll, 3000)
  LOG.rec('info', ['remote.start', deviceId()])
}

export function stopRemote() {
  if (!timer) return
  clearInterval(timer)
  timer = null
}
