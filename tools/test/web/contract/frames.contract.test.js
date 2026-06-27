// 后端契约测试 — 用 ajv 锁定 /api/cc/chat 归一化帧 JSON schema 与 metadata 返回结构。
// 既保证代表性归一化帧通过, 也保证原始 SDK 帧(kind:assistant 等)被拒——这是计划点名的坑。
//
// 帧样本由 reducer 真实消费(双向锁): schema 认的帧, reducer 必须不抛、产出预期 item。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import Ajv from 'ajv'
import { createChatState, applyFrame } from '../../../../app/www/js/normalizedChat.js'

const here = dirname(fileURLToPath(import.meta.url))
const schema = JSON.parse(readFileSync(join(here, 'normalized-frames.schema.json'), 'utf8'))
const ajv = new Ajv({ allErrors: true })
const validate = ajv.compile(schema)

// 代表性归一化帧(对齐 normalized_protocol.py wire 字段)
const VALID_FRAMES = [
  { kind: 'stream_delta', content: 'hi' },
  { kind: 'stream_end' },
  { kind: 'text', role: 'assistant', content: 'hello' },
  { kind: 'text', role: 'user', content: 'q' },
  { kind: 'thinking', content: 'reasoning' },
  { kind: 'tool_use', toolId: 't1', toolName: 'Bash', input: { command: 'ls' } },
  // 后端 _message_to_normalized 真发 content(claude UserMessage tool_result block → content),isError 布尔。
  { kind: 'tool_result', toolId: 't1', content: 'a\nb', isError: false },
  { kind: 'tool_result', toolId: 't2', content: 'boom', isError: true },
  // resultText/result 仅历史兼容字段, 也接受(reducer 兜底), 但后端实际不发。
  { kind: 'tool_result', toolId: 't3', resultText: 'legacy', exitCode: 1 },
  { kind: 'status', text: 'thinking…', canInterrupt: true },
  { kind: 'status', text: 'token_budget', tokenBudget: { used: 1, total: 9 } },
  { kind: 'complete', sessionId: 's', aborted: false },
  // 后端中断真形态: error{code:'interrupted', message}(非 codex 式 complete{aborted})。
  { kind: 'error', code: 'interrupted', message: 'user interrupted' },
  // provider 路径转的 error 走 content。
  { kind: 'error', content: 'provider boom' },
  // 后端 _broadcast_turn_error 在 error 后补发的收口 result 帧(用 is_error/session_id, 非 SDK 的 result 字段)。
  { kind: 'result', is_error: true, session_id: 's1', duration_ms: 0, num_turns: 0, total_cost_usd: 0 },
  { kind: 'session_created', newSessionId: 'new' },
  { kind: 'context_event', status: 'injected', summary: 'plan loaded', planId: 'p/1' },
  { kind: 'permission_request', requestId: 'r1', toolName: 'Bash', input: {} },
  { kind: 'snapshot', messages: [{ kind: 'text', role: 'user', content: 'q1' }], tokenUsage: { used: 1, total: 9 } },
  { kind: 'snapshot', history: [{ role: 'user', text: 'q' }, { role: 'assistant', text: 'a' }] },
]

// 必须被拒的帧(原始 SDK 帧 / 结构不全)
const INVALID_FRAMES = [
  { kind: 'assistant', message: {} },   // SDK 原始帧 — 会让前端无返回, 必须拒
  { kind: 'system', subtype: 'init' },  // SDK 原始帧
  { kind: 'result', result: 'x' },      // SDK 原始 ResultMessage 帧(带 result 字段无 is_error)— 后端不直发这种, 必须拒
  { kind: 'tool_use', toolName: 'Bash' },           // 缺 toolId
  { kind: 'tool_result' },                            // 缺 toolId
  { kind: 'session_created' },                        // 缺 newSessionId
  { kind: 'stream_delta' },                           // 缺 content
  {},                                                 // 无 kind
]

describe('归一化帧 schema 锁定', () => {
  it.each(VALID_FRAMES)('接受归一化帧 %o', (f) => {
    const ok = validate(f)
    if (!ok) console.error(f.kind, validate.errors)
    expect(ok).toBe(true)
  })

  it.each(INVALID_FRAMES)('拒绝非归一化/残缺帧 %o', (f) => {
    expect(validate(f)).toBe(false)
  })

  it('schema 认的每一帧, reducer 都能消费且不抛', () => {
    const s = createChatState('sid')
    for (const f of VALID_FRAMES) {
      expect(validate(f)).toBe(true)
      expect(() => applyFrame(s, f)).not.toThrow()
    }
  })
})

// PATCH /sessions/{sid}/metadata 返回结构
// 真后端 set_effort 返回 effort_applied 为字符串枚举(reconnected/after_current_turn/next_turn/
// unchanged/stored_codex_pending), 不是 boolean(旧 schema 锁 boolean 是失真)。
const APPLIED_ENUM = ['reconnected', 'after_current_turn', 'next_turn', 'unchanged', 'stored_codex_pending']
const metaSchema = {
  type: 'object',
  properties: {
    effort: { type: ['string', 'null'] },
    effort_applied: { type: 'string', enum: APPLIED_ENUM },
    model: { type: ['string', 'null'] },
    effective: { type: 'string' },
  },
  additionalProperties: true,
}
const validateMeta = ajv.compile(metaSchema)

describe('metadata 返回结构锁定', () => {
  it('effort 返回 {effort, effort_applied(字符串), effective}', () => {
    expect(validateMeta({ effort: 'high', effort_applied: 'after_current_turn', effective: 'next_user_turn' })).toBe(true)
  })
  it('effort_applied 支持全部真后端枚举值', () => {
    for (const v of APPLIED_ENUM) {
      expect(validateMeta({ effort: 'high', effort_applied: v })).toBe(true)
    }
  })
  it('model 返回 {model}', () => {
    expect(validateMeta({ model: 'opus', effective: 'next_user_turn' })).toBe(true)
  })
  it('effort 可为 null(default)', () => {
    expect(validateMeta({ effort: null, effort_applied: 'unchanged' })).toBe(true)
  })
  it('effort_applied 为 boolean 被拒(旧失真形态)', () => {
    expect(validateMeta({ effort: 'high', effort_applied: false })).toBe(false)
  })
  it('effort 非法类型被拒', () => {
    expect(validateMeta({ effort: 123 })).toBe(false)
  })
})
