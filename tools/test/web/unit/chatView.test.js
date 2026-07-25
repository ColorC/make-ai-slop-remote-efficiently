// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { expectedMessageCount, snapshotRecordCount } from '../../../../app/www/js/chatView.js'

describe('chat history completeness helpers', () => {
  it('treats absent message counts as unknown without turning them into zero', () => {
    expect(expectedMessageCount(null)).toBeNull()
    expect(expectedMessageCount(undefined)).toBeNull()
    expect(expectedMessageCount('')).toBeNull()
    expect(expectedMessageCount(0)).toBe(0)
    expect(expectedMessageCount('508')).toBe(508)
  })

  it('uses normalized messages as the authoritative snapshot count', () => {
    expect(snapshotRecordCount({
      messages: Array.from({ length: 508 }, (_, i) => ({ id: 'm' + i })),
      history: Array.from({ length: 137 }, (_, i) => ({ id: 'h' + i })),
    })).toBe(508)
    expect(snapshotRecordCount({ messages: [], history: [{ id: 'legacy' }] })).toBe(1)
  })
})
