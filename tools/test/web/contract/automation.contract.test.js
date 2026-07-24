// 后端契约测试 — 用 ajv 锁定 B 档原生无障碍信道 /api/android/automation/* 的
// 命令包 / 各 op 命令参数 / 各 op 执行回执 结构。真源(以代码为准, 非文档摘要):
//   controlplane/android.py: automation_enqueue(命令包字段/去重)、automation_poll(下发)、
//     automation_result(回执落库)、AUTOMATION_OPS(op 白名单)、pairing-window/pair(配对)。
//   DeviceBridgeService.java: 前台服务 poll→执行→回执 {device_id,command_id,sequence,ok,result};
//     stage_media / cleanup_debug_media 由桥本身处理(其余 op 转交无障碍执行器)。
//   LofaAccessibilityService.java: 系统级执行器 ui_tree/tap/click_text/set_text/global_action/
//     launch_app/launch_label/screenshot/status 的真实返回字段。
// 纯 schema 契约: 不连真机、不起服务, 只锁 payload/回执形态与非法样本被拒。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import Ajv from 'ajv'

const here = dirname(fileURLToPath(import.meta.url))
const schema = JSON.parse(readFileSync(join(here, 'automation.schema.json'), 'utf8'))
const ajv = new Ajv({ allErrors: true, strictTypes: false })
ajv.addSchema(schema)
const v = (name) => {
  const fn = ajv.getSchema('lofa://automation#/$defs/' + name)
  if (!fn) throw new Error('no such schema def: ' + name)
  return fn
}

// ── 命令包(enqueue 生成 / poll 下发) ───────────────────────────────────────────
const COMMAND = {
  id: 'a1b2c3d4e5f60718', sequence: 1, op: 'tap',
  args: { nx: 0.5, ny: 0.5 }, created_at: 1_700_000_000.0,
  expires_at: 1_700_000_090.0, idempotency_key: 'k1', status: 'pending',
}

describe('automation 命令包 schema', () => {
  it('接受 enqueue/poll 真实命令包', () => {
    expect(v('command')(COMMAND)).toBe(true)
  })
  it('全部 AUTOMATION_OPS 都是合法 op', () => {
    for (const op of ['status', 'screenshot', 'ui_tree', 'tap', 'click_text', 'set_text',
      'global_action', 'launch_app', 'launch_label', 'stage_media', 'cleanup_debug_media']) {
      expect(v('command')({ ...COMMAND, op })).toBe(true)
    }
  })
  it('拒绝 legacy commands 信道的 op(不同信道, 不通用)', () => {
    for (const op of ['ping', 'toast', 'navigate', 'ota_check', 'ota_install']) {
      expect(v('command')({ ...COMMAND, op })).toBe(false)
    }
  })
  it('拒绝缺 id / 缺 op / 缺 expires_at 的残缺命令包', () => {
    const { id, ...noId } = COMMAND
    const { op, ...noOp } = COMMAND
    const { expires_at, ...noExpiry } = COMMAND
    expect(v('command')(noId)).toBe(false)
    expect(v('command')(noOp)).toBe(false)
    expect(v('command')(noExpiry)).toBe(false)
  })
})

// ── 每个 op 的命令参数(controller enqueue 时应发的 args) ──────────────────────
const VALID_ARGS = [
  ['statusArgs', {}],
  ['screenshotArgs', {}],
  ['uiTreeArgs', {}],
  ['uiTreeArgs', { max_nodes: 250 }],
  ['tapArgs', { nx: 0, ny: 0 }],
  ['tapArgs', { nx: 1, ny: 1 }],
  ['tapArgs', { nx: 0.42, ny: 0.73 }],
  ['clickTextArgs', { text: '发布' }],
  ['clickTextArgs', { text: '发布', exact: false }],
  ['setTextArgs', { text: '正文内容' }],
  ['setTextArgs', { text: '', view_id: 'com.xingin.xhs:id/title' }],
  ['globalActionArgs', { action: 'back' }],
  ['globalActionArgs', { action: 'home' }],
  ['globalActionArgs', { action: 'recents' }],
  ['globalActionArgs', { action: 'notifications' }],
  ['launchAppArgs', { package: 'com.xingin.xhs' }],
  ['launchLabelArgs', { label: '小红书' }],
  ['stageMediaArgs', { assets: [{ url: '/api/android/automation/assets/L/00-x', sha256: 'ab12' }] }],
  ['stageMediaArgs', { assets: [{ url: 'http://pc/a.jpg', sha256: 'ab12', display_name: 'lofa-xhs-1.jpg', mime: 'image/jpeg' }] }],
  ['cleanupDebugMediaArgs', { display_names: ['lofa-xhs-1.png'] }],
]

const INVALID_ARGS = [
  ['uiTreeArgs', { max_nodes: 0 }],           // 下界外(执行器 clamp 1..500)
  ['uiTreeArgs', { max_nodes: 501 }],          // 上界外
  ['tapArgs', { nx: 0.5 }],                    // 缺 ny
  ['tapArgs', { nx: 1.5, ny: 0.5 }],           // 归一化坐标越界(执行器会拒)
  ['tapArgs', { nx: -0.1, ny: 0.5 }],          // 负坐标
  ['tapArgs', { x: 100, y: 200 }],             // 像素坐标非本 op 契约(要归一化)
  ['clickTextArgs', {}],                       // 缺 text
  ['clickTextArgs', { text: '' }],             // 空 text
  ['globalActionArgs', { action: 'swipe' }],   // 非白名单动作
  ['launchAppArgs', {}],                        // 缺 package
  ['launchLabelArgs', { package: 'x' }],        // 该 op 要 label 不是 package
  ['stageMediaArgs', { assets: [] }],           // 空 assets
  ['stageMediaArgs', { assets: [{ url: 'u' }] }], // asset 缺 sha256
  ['cleanupDebugMediaArgs', { display_names: [] }], // 空清单
  ['cleanupDebugMediaArgs', { display_names: Array(65).fill('x.png') }], // 超 64 上限
]

describe('automation 命令参数 schema', () => {
  it.each(VALID_ARGS)('接受 %s 合法参数 %o', (def, args) => {
    const ok = v(def)(args)
    if (!ok) console.error(def, v(def).errors)
    expect(ok).toBe(true)
  })
  it.each(INVALID_ARGS)('拒绝 %s 非法参数 %o', (def, args) => {
    expect(v(def)(args)).toBe(false)
  })
})

// ── 每个 op 的执行回执(receipt.result 成功形态) ───────────────────────────────
const UI_NODE = {
  depth: 2, class: 'android.widget.Button', text: '发布', description: '',
  view_id: 'com.xingin.xhs:id/publish', clickable: true, editable: false,
  enabled: true, focused: false, checkable: false, checked: false,
  selected: false, bounds: '40,1800,1040,1920',
}
const VALID_RESULTS = [
  ['uiTreeResult', { package: 'com.xingin.xhs', nodes: [UI_NODE], timed_out: false, truncated: false }],
  ['uiTreeResult', { package: 'com.xingin.xhs', nodes: [], timed_out: true, truncated: true }],
  ['tapResult', { dispatched: true, x: 540, y: 1200 }],
  ['clickTextResult', { clicked: true, text: '发布' }],
  ['setTextResult', { changed: true, characters: 4, view_id: 'com.xingin.xhs:id/title' }],
  ['globalActionResult', { performed: true, action: 'back' }],
  ['launchAppResult', { launched: true, package: 'com.xingin.xhs' }],
  ['launchLabelResult', { launched: true, package: 'com.xingin.xhs' }],
  ['launchLabelResult', { launched: true, package: 'com.xingin.xhs', label: '小红书', learned_package: 'com.xingin.xhs' }],
  ['screenshotResult', { mime: 'image/jpeg', width: 1080, height: 2400, encoded_width: 576, encoded_height: 1280, base64: 'AAAA' }],
  ['stageMediaResult', { staged: [{ display_name: 'lofa-xhs-1.jpg', uri: 'content://media/external/images/1', sha256: 'ab12', size: 20480 }], count: 1 }],
  ['cleanupDebugMediaResult', { requested: ['lofa-xhs-1.png'], deleted: 1, preserved_relative_path: 'Pictures/LOFA' }],
  ['statusResult', { enabled: true, service_connected: true, android_api: 34, accessibility_connected: true, bridge_running: true, bridge_paired: true, protocol_version: 2, capabilities: ['tap', 'screenshot'] }],
]

const INVALID_RESULTS = [
  ['tapResult', { dispatched: true }],                          // 缺 x/y
  ['uiTreeResult', { package: 'p', nodes: [{ depth: 1 }], timed_out: false, truncated: false }], // node 字段不全
  ['clickTextResult', { clicked: 'yes', text: 't' }],           // clicked 应为 boolean
  ['screenshotResult', { mime: 'image/png', width: 1, height: 1, encoded_width: 1, encoded_height: 1, base64: 'x' }], // mime 恒为 jpeg
  ['setTextResult', { changed: true, characters: 4 }],          // 缺 view_id
  ['launchAppResult', { launched: true }],                       // 缺 package
]

describe('automation 执行回执 result schema', () => {
  it.each(VALID_RESULTS)('接受 %s 成功回执 %o', (def, result) => {
    const ok = v(def)(result)
    if (!ok) console.error(def, v(def).errors)
    expect(ok).toBe(true)
  })
  it.each(INVALID_RESULTS)('拒绝 %s 失真回执 %o', (def, result) => {
    expect(v(def)(result)).toBe(false)
  })
  it('任一 op 失败回执为 {error} 且拒绝多余字段', () => {
    expect(v('errorResult')({ error: 'accessibility executor is not connected' })).toBe(true)
    expect(v('errorResult')({ error: 'tap requires normalized nx and ny in [0,1]' })).toBe(true)
    expect(v('errorResult')({})).toBe(false)
    expect(v('errorResult')({ error: 'x', clicked: false })).toBe(false)
  })
})

// ── 回执封装 / 端点响应 ────────────────────────────────────────────────────────
describe('automation 回执封装与端点响应 schema', () => {
  it('设备回传 POST /automation/result 请求体 {device_id,command_id,sequence,ok,result}', () => {
    expect(v('receiptPost')({ device_id: 'lofa-abc', command_id: 'c1', sequence: 3, ok: true, result: { clicked: true, text: '发布' } })).toBe(true)
    expect(v('receiptPost')({ device_id: 'lofa-abc', command_id: 'c1', ok: false, result: { error: 'x' } })).toBe(true)
  })
  it('回执缺 command_id / result 被拒', () => {
    expect(v('receiptPost')({ device_id: 'd', ok: true, result: {} })).toBe(false)
    expect(v('receiptPost')({ device_id: 'd', command_id: 'c', ok: true })).toBe(false)
  })
  it('服务端落库回执形态 {command_id,ok,result,ts}(丢 device_id/sequence)', () => {
    expect(v('receiptStored')({ command_id: 'c1', ok: true, result: { dispatched: true, x: 1, y: 2 }, ts: 1_700_000_000.0 })).toBe(true)
    expect(v('receiptStored')({ command_id: 'c1', ok: false, result: null, ts: 1.0 })).toBe(true)
  })
  it('enqueue 首次返回带 sequence/expires_at', () => {
    expect(v('enqueueResponse')({ ok: true, device_id: 'd', command_id: 'c', sequence: 1, op: 'tap', expires_at: 1_700_000_090.0, deduplicated: false })).toBe(true)
  })
  it('enqueue 去重命中返回 deduplicated:true 且无 sequence', () => {
    expect(v('enqueueResponse')({ ok: true, device_id: 'd', command_id: 'c', op: 'tap', deduplicated: true })).toBe(true)
  })
  it('poll 响应封装命令数组', () => {
    expect(v('pollResponse')({ ok: true, device_id: 'd', commands: [COMMAND], last_seen: 1.0 })).toBe(true)
    expect(v('pollResponse')({ ok: true, device_id: 'd', commands: [] })).toBe(true)
  })
  it('poll 响应携带非法命令被拒', () => {
    expect(v('pollResponse')({ ok: true, device_id: 'd', commands: [{ id: 'x', op: 'ping', args: {}, sequence: 1, created_at: 0, expires_at: 0 }] })).toBe(false)
  })
  it('pairing-window / pair 响应形态', () => {
    expect(v('pairingWindowResponse')({ ok: true, device_id: 'd', pairing_ip: '10.3.43.246', pairing_expires_at: 1_700_000_900.0 })).toBe(true)
    expect(v('pairResponse')({ ok: true, device_id: 'd', paired: true, last_seen: 1.0 })).toBe(true)
  })
})
