// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { doUpdate, store } from '../../../../app/www/js/core.js'

describe('OTA update concurrency', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="toast"></div>'
    store.base = 'https://10.3.43.246:12443'
    store.update = { manifest: { sha256: 'a'.repeat(64) } }
  })

  it('coalesces repeated taps into one native download', async () => {
    let release
    const downloadAndInstall = vi.fn(() => new Promise((resolve) => { release = resolve }))
    window.Capacitor = {
      Plugins: {
        ApkInstaller: {
          canInstall: vi.fn().mockResolvedValue({ granted: true }),
          downloadAndInstall,
        },
      },
    }

    const first = doUpdate()
    const second = doUpdate()
    await Promise.resolve()

    expect(downloadAndInstall).toHaveBeenCalledTimes(1)
    expect(downloadAndInstall).toHaveBeenCalledWith({
      url: 'https://10.3.43.246:12443/api/android/apk/latest',
      sha256: 'a'.repeat(64),
    })

    release({ submitted: true })
    await Promise.all([first, second])
  })
})
