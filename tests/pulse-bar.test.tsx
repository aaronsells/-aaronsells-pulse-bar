import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  addLifetime,
  buckets,
  clock,
  grouped,
  lifetimeText,
  liveText,
  parseLifetime,
  sparkline,
  span,
  statsText,
  topTools,
  BUCKET_MS,
  STORE_KEY,
} from '../hooks/register'

const T0 = 1_700_000_000_000

const band = (isWorking: boolean, bodyColumns = 100) =>
  ({
    plugin: 'pulse-bar',
    component: 'AbovePrompt',
    requestId: 'band',
    props: {
      hasSurvey: false,
      isCollapsed: false,
      isWorking,
      maxRows: 6,
      bodyColumns,
      scroll: { offset: 0, bodyRows: 6 },
      view: {},
    },
  }) as const

const SURFACES = ['terminal', 'desktop', 'mobile'] as const

/** What sits beneath the plugin: a store in memory (returned, to read back) and a command registry. */
function world(on: On, seed: Record<string, unknown> = {}): Map<string, unknown> {
  const mem = new Map<string, unknown>(Object.entries(seed))
  on('store.get', (_, e) => ({ value: mem.get(e.key) }))
  on('store.set', (_, e) => {
    mem.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'pulse-reset' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return mem
}

const DAY = 86_400_000
const EARLIER = { prompts: 10, toolCalls: 1229, failures: 2, byTool: { Bash: 700, Read: 529 }, since: T0 - DAY }

test('helpers format times, stats and the sparkline', async () => {
  expect(clock(0)).toBe('0:00')
  expect(clock(65_000)).toBe('1:05')
  expect(clock(3_725_000)).toBe('1:02:05')
  expect(span(59_000)).toBe('0m')
  expect(span(3_720_000)).toBe('1h02m')

  const counts = buckets([T0 - 1, T0 - 1, T0 - BUCKET_MS - 1, T0 - 10 * 60_000], T0)
  expect(counts.length).toBe(24)
  expect(counts[23]).toBe(2)
  expect(counts[22]).toBe(1)
  expect(counts.slice(0, 22).every(n => n === 0)).toBe(true)
  expect(sparkline([0, 1, 2]).length).toBe(3)
  expect(sparkline([0, 1, 2])).toBe('▁▅█')

  const s = { prompts: 1, toolCalls: 3, failures: 1, byTool: { Read: 2, Bash: 1 }, startedAt: T0 }
  expect(statsText(s, T0 + 120_000)).toBe('1 prompt · 3 tools · 1 ✗ · 2m')
  expect(topTools(s)).toBe('Top tools: Read 2 · Bash 1')

  const base = { phase: 'tool', active: ['Bash', 'Read'], turnStartedAt: T0, toolStartedAt: T0 + 1000, lastTurnSeconds: null } as const
  expect(liveText(base, T0 + 6000, true)).toBe('Bash +1 0:05 · turn 0:06')
  expect(liveText({ ...base, phase: 'thinking', active: [] }, T0 + 6000, true)).toBe('thinking · turn 0:06')
  expect(liveText({ ...base, phase: 'idle', lastTurnSeconds: 34 }, T0, false)).toBe('idle · last turn 0:34')
})

test('the band counts tool calls and failures, on every surface', async ($, on) => {
  const time = mock.clock(on, { now: T0 })
  world(on)
  let n = 0
  on('tool.call', () => (++n === 3 ? { result: {}, isError: true } : { result: {} }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.tool.call({ tool: 'Read', file_path: '/a' })
  await $.tool.call({ tool: 'Bash', command: 'false' })
  await time.advance(90_000)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...band(false), surface })
    expect((await ui.find({ type: 'Text', text: /tools/ }))?.text).toBe('0 prompts · 3 tools · 1 ✗ · 1m')
    expect(await ui.find({ type: 'Text', text: /^ready$/ })).toBeDefined()

    await ui.press({ key: 'details' })
    expect((await ui.find({ type: 'Text', text: /Top tools/ }))?.text).toBe('Top tools: Bash 2 · Read 1')
    await ui.press({ key: 'details' })
    expect(await ui.find({ type: 'Text', text: /Top tools/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('the sparkline shows recent calls and empties as they age out', async ($, on) => {
  const time = mock.clock(on, { now: T0 })
  world(on)
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Grep', pattern: 'x' })
  await time.advance(1000)

  const ui = await $.ui.mount({ ...band(false), surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /▁/ }))?.text).toBe('▁'.repeat(23) + '█')
  await ui.unmount()

  await time.advance(5 * 60_000)
  const later = await $.ui.mount({ ...band(false), surface: 'desktop' })
  expect((await later.find({ type: 'Text', text: /▁/ }))?.text).toBe('▁'.repeat(24))
  await later.unmount()
})

test('a narrow band drops stats and the sparkline but keeps the live state', async ($, on) => {
  mock.clock(on, { now: T0 })
  world(on)
  await $.session.start({ cwd: '/', surface: 'mobile', isInteractive: true })

  const ui = await $.ui.mount({ ...band(false, 30), surface: 'mobile' })
  expect(await ui.find({ type: 'Text', text: /^ready$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /tools/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /▁/ })).toBeUndefined()
  await ui.unmount()
})

test('lifetime helpers parse, add and format', async () => {
  expect(parseLifetime(undefined)).toBe(null)
  expect(parseLifetime({ prompts: 'x' })).toBe(null)
  expect(parseLifetime({ ...EARLIER, byTool: { Bash: 700, Bad: -1 } })?.byTool).toEqual({ Bash: 700 })
  expect(grouped(1229)).toBe('1,229')
  expect(grouped(12)).toBe('12')
  const next = addLifetime(EARLIER, { toolCalls: 1, failures: 1, tool: 'Edit' })
  expect(next.toolCalls).toBe(1230)
  expect(next.byTool).toEqual({ Bash: 700, Read: 529, Edit: 1 })
  expect(lifetimeText(next)).toBe('Lifetime since Nov 13, 2023: 10 prompts · 1,230 tools · 3 ✗ · top Bash 700, Read 529, Edit 1')
})

test('lifetime totals carry over from earlier sessions and grow', async ($, on) => {
  mock.clock(on, { now: T0 })
  const mem = world(on, { [STORE_KEY]: EARLIER })
  on('tool.call', () => ({ result: {} }))
  on('prompt.submit', (_, e) => ({ text: e.text }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'hello', wait: true, origin: { kind: 'composer' } })
  await Promise.all([
    $.tool.call({ tool: 'Bash', command: 'ls' }),
    $.tool.call({ tool: 'Read', file_path: '/a' }),
    $.tool.call({ tool: 'Grep', pattern: 'x' }),
  ])

  const stored = parseLifetime(mem.get(STORE_KEY))
  expect(stored?.prompts).toBe(11)
  expect(stored?.toolCalls).toBe(1232)
  expect(stored?.byTool).toEqual({ Bash: 701, Read: 530, Grep: 1 })
  expect(stored?.since).toBe(T0 - DAY)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...band(false), surface })
    expect(await ui.find({ type: 'Text', text: /^Lifetime/ })).toBeUndefined()
    await ui.press({ key: 'details' })
    expect((await ui.find({ type: 'Text', text: /^Lifetime/ }))?.text).toBe(
      'Lifetime since Nov 13, 2023: 11 prompts · 1,232 tools · 2 ✗ · top Bash 701, Read 530, Grep 1',
    )
    await ui.press({ key: 'details' })
    await ui.unmount()
  }
})

test('a first run starts counting now, and junk in the store is replaced', async ($, on) => {
  mock.clock(on, { now: T0 })
  const mem = world(on, { [STORE_KEY]: 'not totals' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(parseLifetime(mem.get(STORE_KEY))).toEqual({ prompts: 0, toolCalls: 0, failures: 0, byTool: {}, since: T0 })
})

test('/pulse-reset clears lifetime totals but not the session', async ($, on) => {
  const time = mock.clock(on, { now: T0 })
  const mem = world(on, { [STORE_KEY]: EARLIER })
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await time.advance(60_000)

  const { text } = await $.command.run({
    command: 'pulse-reset',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })
  expect(text).toBe('Pulse Bar lifetime totals reset (were 10 prompts, 1,230 tool calls).')
  expect(parseLifetime(mem.get(STORE_KEY))).toEqual({ prompts: 0, toolCalls: 0, failures: 0, byTool: {}, since: T0 + 60_000 })

  const ui = await $.ui.mount({ ...band(false), surface: 'desktop' })
  await ui.press({ key: 'details' })
  expect((await ui.find({ type: 'Text', text: /^Lifetime/ }))?.text).toBe('Lifetime since Nov 14, 2023: 0 prompts · 0 tools')
  expect((await ui.find({ type: 'Text', text: /^0 prompts · 1 tool/ }))?.text).toBe('0 prompts · 1 tool · 1m')
  await ui.unmount()
})
