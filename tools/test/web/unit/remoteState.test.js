import { describe, expect, it } from 'vitest'
import { automationControlBase } from '../../../../app/www/js/remoteState.js'

describe('automationControlBase', () => {
  it('separates the native control plane from the public HTTPS gateway', () => {
    expect(automationControlBase('https://10.3.43.246:12443'))
      .toBe('http://10.3.43.246:8210')
    expect(automationControlBase('https://lofa.example:12443/'))
      .toBe('http://lofa.example:8210')
  })

  it('keeps unrelated origins unchanged and trims trailing slashes', () => {
    expect(automationControlBase('https://lofa.example/'))
      .toBe('https://lofa.example')
    expect(automationControlBase('http://10.0.0.8:8210/'))
      .toBe('http://10.0.0.8:8210')
  })

  it('fails closed to the supplied value for malformed configuration', () => {
    expect(automationControlBase('')).toBe('')
    expect(automationControlBase('not a url/')).toBe('not a url')
  })
})
