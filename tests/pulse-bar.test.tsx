import { expect, mock, test } from 'claude-code/testing'

import { buckets, clock, liveText, sparkline, span, statsText, topTools, BUCKET_MS } from '../hooks/register'

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
  on('session.start', (_, e) => ({ cwd: e.cwd }))
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
  on('session.start', (_, e) => ({ cwd: e.cwd }))
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
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'mobile', isInteractive: true })

  const ui = await $.ui.mount({ ...band(false, 30), surface: 'mobile' })
  expect(await ui.find({ type: 'Text', text: /^ready$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /tools/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /▁/ })).toBeUndefined()
  await ui.unmount()
})
