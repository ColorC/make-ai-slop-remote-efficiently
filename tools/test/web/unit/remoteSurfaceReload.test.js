// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'

import { store } from '../../../../app/www/js/core.js'
import * as browserView from '../../../../app/www/js/browserView.js'

describe('Dashboard surface reconnect', () => {
  beforeEach(() => {
    store.base = 'https://10.3.43.246:12443'
    document.body.innerHTML = '<div id="viewport"><section class="view" id="browserView"></section></div>'
  })

  it('reloads only an already-opened Dashboard frame with the LOFA client marker', async () => {
    browserView.init()
    const frame = document.querySelector('#browserView iframe')
    browserView.reloadAfterConnect()
    expect(frame.getAttribute('src')).toBeNull()

    await browserView.openHome()
    expect(frame.getAttribute('src')).toBe('https://10.3.43.246:12443/?lofaRemoteWeb=1&client=lofa')
    frame.src = 'https://10.3.43.246:12443/?stale=1'
    browserView.reloadAfterConnect()
    expect(frame.getAttribute('src')).toBe('https://10.3.43.246:12443/?lofaRemoteWeb=1&client=lofa')
  })
})
