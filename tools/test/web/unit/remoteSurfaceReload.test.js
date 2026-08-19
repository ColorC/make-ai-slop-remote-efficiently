// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { store } from '../../../../app/www/js/core.js'
import * as browserView from '../../../../app/www/js/browserView.js'
import * as notes from '../../../../app/www/js/notesView.js'

// 2026-08-19 报障"远程网页无限要求登录"的第二半:网关侧修好后,手机上那张 401 登录页
// 仍然留在 iframe 里 —— 跨源 iframe 的内容读不到,靠 data-url/src 缓存判重就永远不重取。
// 连上(= 设备会话刚铸好)必须让已加载过的远端面重新过一次鉴权。
describe('远端面在连上后重新取', () => {
  beforeEach(() => {
    store.base = 'https://10.3.43.246:12443'
    document.body.innerHTML =
      '<div id="viewport"><section class="view" id="browserView"></section>' +
      '<section class="view" id="notesView"></section></div>'
  })

  it('画布: 重新取同一地址(不是靠 data-url 判重跳过)', () => {
    notes.openNotes()
    const frame = document.getElementById('notesView').querySelector('iframe')
    const url = 'https://10.3.43.246:12443/lofa/overlay/app/notes-web.html'
    expect(frame.getAttribute('src')).toBe(url)

    frame.src = ''                       // 模拟"上次加载留下的是别的东西(401 页)"
    notes.reloadAfterConnect()
    expect(frame.getAttribute('src')).toBe('')   // 没加载过的面不抢在首次打开之前

    frame.src = url
    notes.reloadAfterConnect()
    expect(frame.getAttribute('src')).toBe(url)
    expect(frame.getAttribute('data-url')).toBe(url)
  })

  it('远程网页: 已加载过才重取, 且带 lofaRemoteWeb 标记', async () => {
    browserView.init()
    const frame = document.getElementById('browserView').querySelector('iframe')
    browserView.reloadAfterConnect()
    expect(frame.getAttribute('src')).toBeNull()  // 从未打开 → 不动

    await browserView.openHome()
    expect(frame.getAttribute('src')).toBe('https://10.3.43.246:12443/?lofaRemoteWeb=1')
    frame.src = 'https://10.3.43.246:12443/?stale=1'
    browserView.reloadAfterConnect()
    expect(frame.getAttribute('src')).toBe('https://10.3.43.246:12443/?lofaRemoteWeb=1')
  })
})
