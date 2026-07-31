import { describe, expect, it } from 'vitest'
import { preferredTerminalRenderer, terminalRendererForWindow } from '../../../../app/www/js/terminalRendererPolicy.js'

describe('terminal renderer policy', () => {
  it('keeps ordinary desktop browsers on WebGL', () => {
    expect(preferredTerminalRenderer({ userAgent: 'Mozilla/5.0 Windows NT 10.0', maxTouchPoints: 0 })).toBe('webgl')
  })

  it('defaults Android and native Capacitor runtimes to the DOM renderer', () => {
    expect(preferredTerminalRenderer({ userAgent: 'Mozilla/5.0 (Linux; Android 15; Tablet)' })).toBe('dom')
    expect(preferredTerminalRenderer({ nativePlatform: true })).toBe('dom')
  })

  it('defaults coarse-pointer touch tablets to the DOM renderer', () => {
    expect(preferredTerminalRenderer({ maxTouchPoints: 5, coarsePointer: true })).toBe('dom')
  })

  it('honors an explicit diagnostic override', () => {
    expect(preferredTerminalRenderer({ override: 'webgl', nativePlatform: true })).toBe('webgl')
    expect(preferredTerminalRenderer({ override: 'dom' })).toBe('dom')
  })

  it('reads runtime signals defensively from a window-like object', () => {
    const win = {
      localStorage: { getItem: () => '' },
      Capacitor: { isNativePlatform: () => false },
      matchMedia: () => ({ matches: true }),
      navigator: { userAgent: 'Mozilla/5.0', maxTouchPoints: 2 },
    }
    expect(terminalRendererForWindow(win)).toBe('dom')
  })
})
