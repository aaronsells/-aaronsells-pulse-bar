import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Lifetime, Live, Stats } from '../types'

// ---------------------------------------------------------------------------
// State: everything the band draws lives in $.state, so a hot reload keeps it.
// ---------------------------------------------------------------------------

const IDLE: Live = {
  phase: 'idle',
  active: [],
  turnStartedAt: null,
  toolStartedAt: null,
  lastTurnSeconds: null,
}

const EMPTY: Stats = {
  prompts: 0,
  toolCalls: 0,
  failures: 0,
  byTool: {},
  startedAt: 0,
}

const live = atom({ plugin: 'pulse-bar', key: 'live' } as const, IDLE)
const stats = atom({ plugin: 'pulse-bar', key: 'stats' } as const, EMPTY)
const recent = atom({ plugin: 'pulse-bar', key: 'recent' } as const, [] as readonly number[])
const now = atom({ plugin: 'pulse-bar', key: 'now' } as const, 0)
const isExpanded = atom({ plugin: 'pulse-bar', key: 'isExpanded' } as const, false)
const lifetime = atom({ plugin: 'pulse-bar', key: 'lifetime' } as const, { prompts: 0, toolCalls: 0, failures: 0, byTool: {}, since: 0 } as Lifetime)

/** The $.store key lifetime totals persist under. */
export const STORE_KEY = 'lifetime.v1'

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests).
// ---------------------------------------------------------------------------

/** Sparkline: BUCKETS columns of BUCKET_MS each, newest on the right. */
export const BUCKETS = 24
export const BUCKET_MS = 10_000
export const WINDOW_MS = BUCKETS * BUCKET_MS

const BARS = '▁▂▃▄▅▆▇█'
const SPINNER = '◐◓◑◒'

export function buckets(times: readonly number[], at: number): number[] {
  const out = new Array<number>(BUCKETS).fill(0)
  for (const t of times) {
    const age = at - t
    if (age < 0 || age >= WINDOW_MS) continue
    const i = BUCKETS - 1 - Math.floor(age / BUCKET_MS)
    out[i] = (out[i] ?? 0) + 1
  }
  return out
}

/** One bar glyph per bucket, scaled to the busiest bucket. */
export function sparkline(counts: readonly number[]): string {
  const max = Math.max(1, ...counts)
  return counts
    .map(n => (n === 0 ? BARS[0] : BARS[Math.max(1, Math.round((n / max) * (BARS.length - 1)))]))
    .join('')
}

export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

export function span(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

export function liveText(l: Live, at: number, isWorking: boolean): string {
  if (!isWorking || l.phase === 'idle') {
    return l.lastTurnSeconds === null ? 'ready' : `idle · last turn ${clock(l.lastTurnSeconds * 1000)}`
  }
  const turn = l.turnStartedAt === null ? '' : ` · turn ${clock(at - l.turnStartedAt)}`
  if (l.phase === 'tool' && l.active.length > 0) {
    const more = l.active.length > 1 ? ` +${l.active.length - 1}` : ''
    const held = l.toolStartedAt === null ? '' : ` ${clock(at - l.toolStartedAt)}`
    return `${l.active[0]}${more}${held}${turn}`
  }
  return `thinking${turn}`
}

export function statsText(s: Stats, at: number): string {
  const parts = [plural(s.prompts, 'prompt'), plural(s.toolCalls, 'tool')]
  if (s.failures > 0) parts.push(`${s.failures} ✗`)
  if (s.startedAt > 0) parts.push(span(at - s.startedAt))
  return parts.join(' · ')
}

export function topTools(s: Stats, limit = 6): string {
  const rows = Object.entries(s.byTool).sort((a, b) => b[1] - a[1])
  if (rows.length === 0) return 'No tool calls yet.'
  const head = rows.slice(0, limit).map(([tool, n]) => `${tool} ${n}`)
  const rest = rows.length > limit ? ` · +${rows.length - limit} more` : ''
  return `Top tools: ${head.join(' · ')}${rest}`
}

/** Raster cells for the terminal: [codePoint, fg, bg] u32 LE triplets, base64. */
const DEFAULT_BG = 0x01000000
const BAR_FG = 0x00d97757
const EMPTY_FG = 0x00505050
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function base64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1] ?? 0
    const c = bytes[i + 2] ?? 0
    const n = (a << 16) | (b << 8) | c
    out += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63)
    out += i + 1 < bytes.length ? B64.charAt((n >> 6) & 63) : '='
    out += i + 2 < bytes.length ? B64.charAt(n & 63) : '='
  }
  return out
}

export function rasterCells(counts: readonly number[]): string {
  const line = sparkline(counts)
  const words = new Uint32Array(counts.length * 3)
  for (let i = 0; i < counts.length; i++) {
    words[i * 3] = line.charCodeAt(i)
    words[i * 3 + 1] = (counts[i] ?? 0) === 0 ? EMPTY_FG : BAR_FG
    words[i * 3 + 2] = DEFAULT_BG
  }
  const bytes = new Uint8Array(words.buffer)
  // Uint32Array is platform-endian; the contract wants little-endian.
  const isLE = new Uint8Array(Uint32Array.of(1).buffer)[0] === 1
  if (!isLE) {
    for (let i = 0; i < bytes.length; i += 4) {
      bytes.set([bytes[i + 3] ?? 0, bytes[i + 2] ?? 0, bytes[i + 1] ?? 0, bytes[i] ?? 0], i)
    }
  }
  return base64(bytes)
}

/** Lifetime totals: what a session adds to them. */
export type LifetimeDelta = { prompts?: number; toolCalls?: number; failures?: number; tool?: string }

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

/** Reads a stored value back, or null when it is missing or not ours. */
export function parseLifetime(v: unknown): Lifetime | null {
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  if (!isCount(o.prompts) || !isCount(o.toolCalls) || !isCount(o.failures) || !isCount(o.since)) return null
  if (typeof o.byTool !== 'object' || o.byTool === null) return null
  const byTool: Record<string, number> = {}
  for (const [k, n] of Object.entries(o.byTool as Record<string, unknown>)) {
    if (isCount(n)) byTool[k] = n
  }
  return { prompts: o.prompts, toolCalls: o.toolCalls, failures: o.failures, byTool, since: o.since }
}

export function freshLifetime(at: number): Lifetime {
  return { prompts: 0, toolCalls: 0, failures: 0, byTool: {}, since: at }
}

export function addLifetime(l: Lifetime, d: LifetimeDelta): Lifetime {
  return {
    ...l,
    prompts: l.prompts + (d.prompts ?? 0),
    toolCalls: l.toolCalls + (d.toolCalls ?? 0),
    failures: l.failures + (d.failures ?? 0),
    byTool: d.tool === undefined ? l.byTool : { ...l.byTool, [d.tool]: (l.byTool[d.tool] ?? 0) + 1 },
  }
}

/** 1830 -> "1,830" without leaning on Intl. */
export function grouped(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function lifetimeText(l: Lifetime, limit = 3): string {
  const d = new Date(l.since)
  const since = l.since > 0 ? ` since ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}` : ''
  const parts = [`${grouped(l.prompts)} prompts`, `${grouped(l.toolCalls)} tools`]
  if (l.failures > 0) parts.push(`${grouped(l.failures)} ✗`)
  const top = Object.entries(l.byTool)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([tool, n]) => `${tool} ${grouped(n)}`)
  if (top.length > 0) parts.push(`top ${top.join(', ')}`)
  return `Lifetime${since}: ${parts.join(' · ')}`
}

function withoutOne(list: readonly string[], item: string): string[] {
  const i = list.indexOf(item)
  return i < 0 ? [...list] : [...list.slice(0, i), ...list.slice(i + 1)]
}

// Lifetime writes re-read the store and add to it, one at a time, so parallel
// tool calls in this session never overwrite each other's counts.
let queue: Promise<unknown> = Promise.resolve()

function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn)
  queue = run.catch(() => undefined)
  return run
}

async function bumpLifetime($: EngineInterface, d: LifetimeDelta): Promise<void> {
  await serial(async () => {
    const stored = parseLifetime(await $.store.get(STORE_KEY)) ?? freshLifetime(await $.clock.now())
    const next = addLifetime(stored, d)
    await $.store.set(STORE_KEY, next)
    await update($, lifetime, () => next)
  })
}

// ---------------------------------------------------------------------------
// Hooks.
// ---------------------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const t = await $.clock.now()
    // A reload runs this again: keep the session's totals, reset what's live.
    await update($, stats, s => (s.startedAt > 0 ? s : { ...s, startedAt: t }))
    await update($, live, l => ({ ...IDLE, lastTurnSeconds: l.lastTurnSeconds }))
    await update($, now, () => t)

    // Load lifetime totals from the store (first run: start counting now).
    await serial(async () => {
      const stored = parseLifetime(await $.store.get(STORE_KEY))
      const value = stored ?? freshLifetime(t)
      if (stored === null) await $.store.set(STORE_KEY, value)
      await update($, lifetime, () => value)
    })

    await $.command.register({
      name: 'pulse-reset',
      description: 'Reset Pulse Bar lifetime totals and start counting again',
    })

    // One tick a second moves the elapsed times and slides the sparkline.
    // Idle with an empty window, it writes nothing, so nothing redraws.
    $.clock.every(1000, async () => {
      const at = await $.clock.now()
      const l = await read($, live)
      const r = await read($, recent)
      const kept = r.filter(x => at - x < WINDOW_MS)
      if (kept.length !== r.length) await update($, recent, () => kept)
      if (l.phase !== 'idle' || kept.length > 0) await update($, now, () => at)
    })

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (!e.command) {
      await update($, stats, s => ({ ...s, prompts: s.prompts + 1 }))
      await bumpLifetime($, { prompts: 1 })
    }
    return next(e)
  }).catch(($, e, next) => next(e)) // observe only: never block a prompt

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const t = await $.clock.now()
      await update($, live, (l): Live => ({ ...l, phase: 'thinking', active: [], turnStartedAt: t, toolStartedAt: null }))
      await update($, now, () => t)
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const t = await $.clock.now()
    await update($, live, (l): Live => ({
      ...l,
      phase: 'tool',
      active: [...l.active, e.tool],
      toolStartedAt: l.active.length === 0 ? t : l.toolStartedAt,
      turnStartedAt: l.turnStartedAt ?? t,
    }))
    await update($, recent, r => [...r.filter(x => t - x < WINDOW_MS), t])
    await update($, now, () => t)

    const result = await next(e)

    const failed = typeof result.deny === 'string' || result.isError === true
    const done = await $.clock.now()
    await update($, stats, s => ({
      ...s,
      toolCalls: s.toolCalls + 1,
      failures: s.failures + (failed ? 1 : 0),
      byTool: { ...s.byTool, [e.tool]: (s.byTool[e.tool] ?? 0) + 1 },
    }))
    await update($, live, (l): Live => {
      const active = withoutOne(l.active, e.tool)
      if (active.length > 0) return { ...l, active }
      return { ...l, active, toolStartedAt: null, phase: l.phase === 'idle' ? 'idle' : 'thinking' }
    })
    await update($, now, () => done)
    await bumpLifetime($, { toolCalls: 1, failures: failed ? 1 : 0, tool: e.tool })

    return result
  }).catch(($, e, next) => next(e)) // observe only: a stats failure must not fail the tool

  on('command.run', { command: 'pulse-reset' }, async $ => {
    const before = await read($, lifetime)
    const at = await $.clock.now()
    await serial(async () => {
      const value = freshLifetime(at)
      await $.store.set(STORE_KEY, value)
      await update($, lifetime, () => value)
    })
    return {
      text: `Pulse Bar lifetime totals reset (were ${grouped(before.prompts)} prompts, ${grouped(before.toolCalls)} tool calls).`,
    }
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, live, () => ({ ...IDLE, lastTurnSeconds: Math.round(e.durationMs / 1000) }))
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const l = await read($, live)
    const s = await read($, stats)
    const r = await read($, recent)
    const at = Math.max(await read($, now), s.startedAt)
    const expanded = await read($, isExpanded)
    const lt = await read($, lifetime)
    const { Box, Text, Button } = $.ui.resolve(e)

    const cols = e.props.bodyColumns
    const working = e.props.isWorking && l.phase !== 'idle'
    const glyph = working ? SPINNER[Math.floor(at / 1000) % SPINNER.length] : '○'
    const counts = buckets(r, at)

    const row = [
      <Text color={working ? 'claude' : 'inactive'} bold>
        {glyph}
      </Text>,
      <Text color={working ? 'text' : 'subtle'}>
        {liveText(l, at, e.props.isWorking)}
      </Text>,
    ]

    if (cols >= 44) {
      row.push(
        <Text dimColor>│</Text>,
        <Text dimColor tabular>
          {statsText(s, at)}
        </Text>,
      )
    }

    if (cols >= 72) {
      row.push(<Text dimColor>│</Text>)
      if (e.surface === 'terminal') {
        const { Raster } = $.ui.resolve(e)
        row.push(<Raster key="spark" columns={BUCKETS} rows={1} cells={rasterCells(counts)} />)
      } else {
        row.push(
          <Text mono color="claude">
            {sparkline(counts)}
          </Text>,
        )
      }
    }

    row.push(
      <Button
        key="details"
        label={expanded ? 'less' : 'more'}
        plain
        onPress={() => update($, isExpanded, x => !x)}
      />,
    )

    const lines = [
      <Box key="main" flexDirection="row" gap={1}>
        {row}
      </Box>,
    ]
    if (expanded) {
      lines.push(
        <Text dimColor wrap="truncate-end">
          {topTools(s)}
        </Text>,
        <Text dimColor wrap="truncate-end">
          {lifetimeText(lt)}
        </Text>,
      )
    }

    return <Box flexDirection="column">{lines}</Box>
  })
}
