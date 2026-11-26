import { test, expect } from 'claude-code/testing'
import type { DoubleUpState, SeatJson } from '../types/state'

// A gate the test opens when the plugin reaches a step it can observe.
function gate<T>() {
  return Promise.withResolvers<T>()
}

// A sleep that never resolves: parks a background loop for good.
function park(): Promise<never> {
  return Promise.withResolvers<never>().promise
}

// $.http.fetch answers cross the sandbox as plain data: { status, body }.
const answer = (status: number, body: unknown) => ({ value: { status, body } })

// The atom wrapper's shape is fixed by claude-code: { shape, value }.
function unwrap(stored: unknown): unknown {
  return typeof stored === 'object' && stored !== null && 'value' in stored ? stored.value : undefined
}

const seeded = (over: Partial<DoubleUpState>): DoubleUpState => ({
  wokenEventIds: [],
  lastEventId: 0,
  seenEventIds: [],
  turnCount: 0,
  lastBranch: null,
  injectedEventIds: [],
  inbox: [],
  seats: null,
  matchState: null,
  volleyCount: 0,
  rallyCap: 0,
  ...over,
})

const seat = (side: 'us' | 'them', role: 'human' | 'agent', name: string, repo: string | null = null): SeatJson => ({
  id: 1, side, role, display_name: name, status: null, status_at: null,
  last_seen_at: null, presence: 'online', auto_return: false, harness: null, repo_remote: repo,
})

function textOf(out: unknown): string {
  if (typeof out === 'object' && out !== null && 'text' in out && typeof out.text === 'string') return out.text
  if (typeof out === 'object' && out !== null && 'value' in out) return textOf(out.value)
  return String(out)
}

type OnStub = Parameters<Parameters<typeof test>[1]>[1]

// Stubs every test needs: the engine tier under session.start, a toast
// sink the test can watch, and a clock that parks so the poll loop idles.
function baseStubs(on: OnStub, opts: {
  sleep?: () => unknown
  toast?: (text: string) => void
  onSubmit?: (text: string) => void
  storeGet?: (key: string) => unknown
  onStoreSet?: (key: string, value: unknown) => void
  onStoreDelete?: (key: string) => void
  process?: (argv: string) => { exitCode: number; stdout: string; stderr: string }
} = {}) {
  on('command.register', () => ({ value: { command: 'doubleup' } }))
  on('tool.register', () => ({ value: { tool: 'listed' } }))
  on('session.start', (_d, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_d, e) => {
    const text = String((e as { text?: unknown }).text ?? '')
    opts.onSubmit?.(text)
    return { text }
  })
  on('ui.toast', (_d, e) => {
    opts.toast?.(String(e.text ?? ''))
    return { value: {} }
  })
  on('clock.sleep', opts.sleep ?? (() => park()))
  // The plugin persists its token through $.store and reads the hostname
  // when it names a new device: unstubbed, both would hang a test. The kit
  // allows one handler per event, so overrides ride the opts.
  on('store.get', (_d, e) => ({ value: opts.storeGet?.(String(e.key ?? '')) }))
  on('store.set', (_d, e) => {
    opts.onStoreSet?.(String(e.key ?? ''), e.value)
    return { value: undefined }
  })
  on('store.delete', (_d, e) => {
    opts.onStoreDelete?.(String(e.key ?? ''))
    return { value: undefined }
  })
  on('process.run', (_d, e) => {
    const argv = Array.isArray((e as { argv?: unknown }).argv) ? (e as { argv: string[] }).argv.join(' ') : ''
    if (opts.process) return { value: opts.process(argv) }
    // Default: the hostname only; git facts are each test's own business.
    if (argv === 'hostname') return { value: { exitCode: 0, stdout: 'rig.local\n', stderr: '' } }
    return { value: { exitCode: 1, stdout: '', stderr: '' } }
  })
}

test('login walks the device flow; status and logout follow the token', async ($, on) => {
  const signedIn = gate<void>()
  const stored: { key: string; value: unknown }[] = []
  baseStubs(on, {
    toast: text => {
      if (text.includes('Ace')) signedIn.resolve()
    },
    onStoreSet: (key, value) => {
      stored.push({ key, value })
    },
  })
  on('ui.render', () => ({ value: {} }))
  on('ui.invalidate', () => ({ value: {} }))
  on('ui.panes', () => ({ value: [] }))
  on('audio.play', () => ({ value: {} }))
  on('http.fetch', (_d, e) => {
    const url = String(e.url ?? '')
    if (url.endsWith('/device/authorize')) {
      return answer(201, { user_code: 'WTX5', device_code: 'dc', verification_url: 'https://x/device', interval: 5 })
    }
    return answer(200, { token: 'tok-9' })
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const login = await $.command.run({ command: 'doubleup', args: 'login' })
  const loginText = textOf(login)
  expect(loginText.includes('WTX5')).toBe(true)
  expect(loginText.includes('https://x/device')).toBe(true)

  await signedIn.promise // the background token poll landed
  expect(stored.some(s => s.key === 'auth' &&
    typeof s.value === 'object' && s.value !== null &&
    (s.value as { token?: unknown }).token === 'tok-9')).toBe(true)
  expect(textOf(await $.command.run({ command: 'doubleup', args: 'status' }))).toContain('Signed in')

  expect(textOf(await $.command.run({ command: 'doubleup', args: 'logout' }))).toContain('Logged out')
  expect(textOf(await $.command.run({ command: 'doubleup', args: 'status' }))).toContain('Not logged in')
})

test('the band shows the court while a rally is live', async ($, on) => {
  baseStubs(on)
  const court = seeded({
    token: 'tok-1', matchId: 7, matchState: 'live', volleyCount: 2, rallyCap: 10,
    seats: [seat('us', 'human', 'Sam'), seat('us', 'agent', "Sam's agent"), seat('them', 'human', 'Alex')],
  })
  on('state.get', (_d, e) => ({
    value: {
      value: e.key === 'state'
        ? { shape: 'state-2', value: court }
        : { shape: 'poll-1', value: { interval: 3000 } },
      version: 1,
    },
  }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ plugin: 'doubleup', component: 'AbovePrompt', surface: 'terminal', props: {} })
  const us = await ui.find({ type: 'Text', text: /Sam/ })
  expect(us?.text).toContain('● Sam')
  const score = await ui.find({ type: 'Text', text: /Rally 2\/10/ })
  expect(score?.text).toContain('live')
  await ui.unmount()
})

test('the band stays away with no court', async ($, on) => {
  baseStubs(on)
  const bare = await $.ui.mount({ plugin: 'doubleup', component: 'AbovePrompt', surface: 'terminal', props: {} })
  expect(await bare.find({ type: 'Text', text: /Rally/ })).toBe(undefined)
  await bare.unmount()
})

test('the band stays away once the match is over', async ($, on) => {
  baseStubs(on)
  const over = seeded({ token: 'tok-1', matchId: 7, matchState: 'finished', seats: [seat('us', 'human', 'Sam')] })
  on('state.get', (_d, e) => ({
    value: {
      value: e.key === 'state'
        ? { shape: 'state-2', value: over }
        : { shape: 'poll-1', value: { interval: 3000 } },
      version: 1,
    },
  }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const gone = await $.ui.mount({ plugin: 'doubleup', component: 'AbovePrompt', surface: 'terminal', props: {} })
  expect(await gone.find({ type: 'Text', text: /●/ })).toBe(undefined)
  await gone.unmount()
})

test('the poll loop folds the feed in and the ladder backs off when quiet', async ($, on) => {
  let court: DoubleUpState = seeded({ token: 'tok-1', matchId: 7, lastEventId: 3 })
  let interval = 3000
  const sleeps: number[] = []
  const feeds: string[] = []
  const stepped = gate<void>()
  baseStubs(on, { sleep: () => {
    sleeps.push(interval)
    if (sleeps.length === 3) stepped.resolve()
    return sleeps.length >= 3 ? park() : { value: {} }
  } })
  on('state.get', (_d, e) => ({
    value: {
      value: e.key === 'state'
        ? { shape: 'state-2', value: court }
        : { shape: 'poll-1', value: { interval } },
      version: 1,
    },
  }))
  on('state.set', (_d, e) => {
    const stored = unwrap(e.value) as DoubleUpState | { interval: number } // atom wrapper, fixed shape
    if (e.key === 'state') court = stored as DoubleUpState
    else interval = (stored as { interval: number }).interval
    // update() commits only when the answer says the write landed.
    return { value: { isSet: true } }
  })
  let cycle = 0
  on('http.fetch', (_d, e) => {
    feeds.push(String(e.url ?? ''))
    cycle += 1
    if (cycle === 1) {
      return answer(200, {
        events: [{
          id: 4, kind: 'chat', body: 'lunch?', refs: [], side: 'them', role: 'human',
          name: 'Alex', to_side: null, client_event_id: 'c4', created_at: '2026-11-22T12:00:00Z',
        }],
        seats: [seat('us', 'human', 'Sam'), seat('them', 'human', 'Alex')],
        volley_count: 1, rally_cap: 10, wake: false,
      })
    }
    return answer(304, null)
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await stepped.promise // two cycles done, the third sleep queued

  expect(feeds[0]).toContain('after=3')
  expect(feeds[1]).toContain('after=4')
  expect(court.lastEventId).toBe(4)
  expect(court.matchState).toBe('live')
  // Cycle 1 had work (stay at 3s), then two quiet cycles step up and hold.
  expect(sleeps).toEqual([3000, 3000, 15000])
})

const MATCH_BODY = (over: boolean) => ({
  id: 9, title: 'Billing bug', state: over ? 'finished' : 'waiting',
  rally_cap: 6, volley_count: over ? 6 : 0,
  seats: [
    { id: 1, side: 'us', role: 'human', display_name: 'Sam', status: null, status_at: null,
      last_seen_at: null, presence: 'online', auto_return: false, harness: null, repo_remote: 'github.com/acme/api' },
    { id: 2, side: 'us', role: 'agent', display_name: "Sam's agent", status: null, status_at: null,
      last_seen_at: null, presence: 'online', auto_return: false, harness: null, repo_remote: 'github.com/acme/api' },
  ],
})

test('serve creates the court, opens the pane, and shows the invite link', async ($, on) => {
  baseStubs(on, { process: argv => ({ exitCode: 0, stdout: argv.includes('rev-parse') ? 'main\n' : 'git@github.com:acme/app.git\n', stderr: '' }) })
  let court = seeded({ token: 'tok-1' })
  const posts: string[] = []
  const opens: string[] = []
  on('state.get', (_d, e) => ({
    value: {
      value: e.key === 'state'
        ? { shape: 'state-2', value: court }
        : { shape: 'poll-1', value: { interval: 3000 } },
      version: 1,
    },
  }))
  on('state.set', (_d, e) => {
    if (e.key === 'state') court = unwrap(e.value) as DoubleUpState
    return { value: { isSet: true } }
  })
  on('http.fetch', (_d, e) => {
    posts.push(`${String((e.init as { method?: string } | undefined)?.method ?? 'GET')} ${String(e.url ?? '')} ${String((e.init as { body?: string } | undefined)?.body ?? '')}`)
    if (String(e.url ?? '').endsWith('/api/v1/matches')) {
      return answer(201, { ...MATCH_BODY(false), invite_token: 'inv-tok' })
    }
    return answer(200, {})
  })
  on('ui.open', (_d, e) => {
    opens.push(String(e.id ?? ''))
    return { value: { isPlaced: true } }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const out = textOf(await $.command.run({ command: 'doubleup', args: 'serve alex@x.test' }))
  const servePost = posts.find(p => p.startsWith('POST') && p.includes('/api/v1/matches'))
  expect(servePost).toContain('"invite":{"email":"alex@x.test"}')
  expect(servePost).toContain('"repo_remote":"git@github.com:acme/app.git"')
  expect(opens).toContain('doubleup-court')
  expect(out).toContain('Invite link: https://www.doubleup.tech/courts/9?invite=inv-tok')
  expect(court.matchId).toBe(9)
  expect(court.matchState).toBe('waiting')
})

test('join takes a link, sends the local repo, and opens the pane', async ($, on) => {
  baseStubs(on, { process: argv => ({ exitCode: 0, stdout: argv.includes('rev-parse') ? 'main\n' : 'git@github.com:acme/web.git\n', stderr: '' }) })
  let court = seeded({ token: 'tok-1' })
  const posts: string[] = []
  const opens: string[] = []
  on('state.get', (_d, e) => ({
    value: {
      value: e.key === 'state'
        ? { shape: 'state-2', value: court }
        : { shape: 'poll-1', value: { interval: 3000 } },
      version: 1,
    },
  }))
  on('state.set', (_d, e) => {
    if (e.key === 'state') court = unwrap(e.value) as DoubleUpState
    return { value: { isSet: true } }
  })
  on('http.fetch', (_d, e) => {
    const url = String(e.url ?? '')
    posts.push(`${url} ${String((e.init as { body?: string } | undefined)?.body ?? '')}`)
    if (url.includes('/join')) {
      expect(url).toContain('token=inv-9')
      return answer(200, MATCH_BODY(false))
    }
    return answer(200, {})
  })
  on('ui.open', (_d, e) => {
    opens.push(String(e.id ?? ''))
    return { value: { isPlaced: true } }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const out = textOf(await $.command.run({ command: 'doubleup', args: 'join https://www.doubleup.tech/courts/9?invite=inv-9' }))
  expect(out).toContain('Court 9 joined')
  expect(opens).toContain('doubleup-court')
  expect(court.matchId).toBe(9)
  expect(posts.some(p => p.includes('/join') && p.includes('"repo_remote":"git@github.com:acme/web.git"'))).toBe(true)
})

test('the pane renders the court, and the auto toggle PATCHes the agent seat', async ($, on) => {
  baseStubs(on)
  const agentSeat = { ...seat('us', 'agent', "Sam's agent"), id: 2, auto_return: false }
  let court = seeded({
    token: 'tok-1', matchId: 9, matchState: 'live', volleyCount: 3, rallyCap: 6,
    seats: [seat('us', 'human', 'Sam', 'github.com/acme/api'), agentSeat, seat('them', 'human', 'Alex', 'github.com/acme/web')],
    inbox: [{
      id: 12, kind: 'serve', body: 'Fixed the invoice loop', refs: [{ type: 'branch', name: 'fix/billing' }],
      side: 'us', role: 'agent', name: "Sam's agent", to_side: 'them',
      client_event_id: 's12', created_at: '2026-11-22T12:00:00Z',
    }],
  })
  const patches: string[] = []
  on('state.get', (_d, e) => ({
    value: {
      value: e.key === 'state'
        ? { shape: 'state-2', value: court }
        : { shape: 'poll-1', value: { interval: 3000 } },
      version: 1,
    },
  }))
  on('state.set', (_d, e) => {
    if (e.key === 'state') court = unwrap(e.value) as DoubleUpState
    return { value: { isSet: true } }
  })
  on('http.fetch', (_d, e) => {
    if (String((e.init as { method?: string } | undefined)?.method ?? '') === 'PATCH') patches.push(String(e.url ?? ''))
    return answer(200, {})
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const pane = await $.ui.mount({
    plugin: 'doubleup', component: 'Pane', requestId: 'doubleup-court', surface: 'terminal',
    props: { title: 'Double Up court', viewport: { rows: 20 } },
  })
  const header = await pane.find({ type: 'Text', text: /court 9/ })
  expect(header?.text).toContain('Rally 3/6')
  const repos = await pane.find({ type: 'Text', text: /repos:/ })
  expect(repos?.text).toContain('github.com/acme/api ⇄ github.com/acme/web')
  const serve = await pane.find({ type: 'Text', text: /Fix the invoice|invoice loop/ })
  expect(serve?.text).toContain('⎇ fix/billing')

  const out = textOf(await $.command.run({ command: 'doubleup', args: 'auto on' }))
  expect(out).toContain('Auto-return on')
  expect(patches.some(p => p.endsWith('/api/v1/matches/9/seats/2'))).toBe(true)
  const mine = (court.seats ?? []).find(s => s.id === 2)
  expect(mine?.auto_return).toBe(true)
  await pane.unmount()
})

test('a stored token restores the login on session start', async ($, on) => {
  const deleted: string[] = []
  const calls: string[] = []
  baseStubs(on, {
    storeGet: key => (key === 'auth' ? { token: 'tok-9' } : undefined),
    onStoreDelete: key => { deleted.push(key) },
  })
  let court = seeded({})
  on('state.get', (_d, e) => ({
    value: {
      value: e.key === 'state'
        ? { shape: 'state-2', value: court }
        : { shape: 'poll-1', value: { interval: 3000 } },
      version: 1,
    },
  }))
  on('state.set', (_d, e) => {
    if (e.key === 'state') court = unwrap(e.value) as DoubleUpState
    return { value: { isSet: true } }
  })
  on('http.fetch', (_d, e) => {
    const url = String(e.url ?? '')
    calls.push(`${String((e.init as { method?: string } | undefined)?.method ?? 'GET')} ${url}`)
    if (url.endsWith('/api/v1/me')) return answer(200, { matches: [{ id: 9, state: 'waiting' }] })
    if (url.endsWith('/api/v1/matches/9')) return answer(200, MATCH_BODY(false))
    return answer(200, {})
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect(calls.some(c => c.endsWith('/api/v1/me'))).toBe(true)
  expect(court.token).toBe('tok-9')
  expect(court.matchId).toBe(9)
  expect(textOf(await $.command.run({ command: 'doubleup', args: 'status' }))).toContain('Signed in')

  expect(textOf(await $.command.run({ command: 'doubleup', args: 'logout' }))).toContain('Logged out')
  expect(deleted).toContain('auth')
  expect(calls.some(c => c.startsWith('DELETE') && c.endsWith('/api/v1/device/revoke'))).toBe(true)
  expect(court.token).toBe(undefined)
})

test('/doubleup name renames the device', async ($, on) => {
  baseStubs(on)
  let court = seeded({ token: 'tok-1' })
  const bodies: string[] = []
  on('state.get', (_d, e) => ({
    value: {
      value: e.key === 'state'
        ? { shape: 'state-2', value: court }
        : { shape: 'poll-1', value: { interval: 3000 } },
      version: 1,
    },
  }))
  on('state.set', (_d, e) => {
    if (e.key === 'state') court = unwrap(e.value) as DoubleUpState
    return { value: { isSet: true } }
  })
  on('http.fetch', (_d, e) => {
    const url = String(e.url ?? '')
    if (url.endsWith('/api/v1/device/rename')) {
      bodies.push(String((e.init as { body?: string } | undefined)?.body ?? ''))
      return answer(200, { name: 'kitchen pi' })
    }
    return answer(200, {})
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const out = textOf(await $.command.run({ command: 'doubleup', args: 'name kitchen pi' }))
  expect(out).toContain('kitchen pi')
  expect(bodies.some(b => b.includes('kitchen pi'))).toBe(true)

  expect(textOf(await $.command.run({ command: 'doubleup', args: 'name' }))).toContain('Try:')
})

test('the pane colors us pink and them cyan', async ($, on) => {
  baseStubs(on)
  let court = seeded({
    token: 'tok-1', matchId: 9, matchState: 'live', volleyCount: 1, rallyCap: 6,
    seats: [seat('us', 'human', 'Sam'), seat('us', 'agent', "Sam's agent"),
            seat('them', 'human', 'Alex'), seat('them', 'agent', "Alex's agent")],
    inbox: [{
      id: 20, kind: 'chat', body: 'Hello from us', refs: [],
      side: 'us', role: 'human', name: 'Sam', to_side: 'them',
      client_event_id: 'c20', created_at: '2026-11-22T12:00:00Z',
    }],
  })
  on('state.get', (_d, e) => ({
    value: {
      value: e.key === 'state'
        ? { shape: 'state-2', value: court }
        : { shape: 'poll-1', value: { interval: 3000 } },
      version: 1,
    },
  }))
  on('state.set', (_d, e) => {
    if (e.key === 'state') court = unwrap(e.value) as DoubleUpState
    return { value: { isSet: true } }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const pane = await $.ui.mount({
    plugin: 'doubleup', component: 'Pane', requestId: 'doubleup-court', surface: 'terminal',
    props: { title: 'Double Up court', viewport: { rows: 20 } },
  })
  const usLine = await pane.find({ type: 'Text', text: /Sam's agent/ })
  expect(usLine?.props.color).toBe('#ff3d9a')
  const themLine = await pane.find({ type: 'Text', text: /Alex's agent/ })
  expect(themLine?.props.color).toBe('#1fe5ff')
  const chat = await pane.find({ type: 'Text', text: /Hello from us/ })
  expect(chat?.props.color).toBe('#ff3d9a')
  await pane.unmount()
})

test('a 401 signs out with a toast and stops watching the court', async ($, on) => {
  let court: DoubleUpState = seeded({ token: 'tok-1', matchId: 7, lastEventId: 0 })
  let interval = 3000
  const toasts: string[] = []
  const sleeps: number[] = []
  const drained = gate<void>()
  baseStubs(on, {
    sleep: () => {
      sleeps.push(interval)
      if (sleeps.length >= 2) drained.resolve()
      return sleeps.length >= 2 ? park() : { value: {} }
    },
    toast: (text: string) => { toasts.push(text) },
  })
  on('state.get', (_d, e) => ({
    value: {
      value: e.key === 'state'
        ? { shape: 'state-2', value: court }
        : { shape: 'poll-1', value: { interval } },
      version: 1,
    },
  }))
  on('state.set', (_d, e) => {
    const stored = unwrap(e.value)
    if (e.key === 'state') court = stored as DoubleUpState
    else interval = (stored as { interval: number }).interval
    return { value: { isSet: true } }
  })
  on('http.fetch', () => answer(401, { error: 'invalid_token' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await drained.promise

  expect(toasts.some(t => t.includes('Signed out'))).toBe(true)
  expect(court.token).toBe(undefined)
})

test('a 404 clears the court and climbs the ladder instead of spinning', async ($, on) => {
  let court: DoubleUpState = seeded({ token: 'tok-1', matchId: 7, lastEventId: 0, seats: [seat('us', 'human', 'Sam')] })
  let interval = 3000
  const sleeps: number[] = []
  const drained = gate<void>()
  baseStubs(on, {
    sleep: () => {
      sleeps.push(interval)
      if (sleeps.length >= 3) drained.resolve()
      return sleeps.length >= 3 ? park() : { value: {} }
    },
  })
  on('state.get', (_d, e) => ({
    value: {
      value: e.key === 'state'
        ? { shape: 'state-2', value: court }
        : { shape: 'poll-1', value: { interval } },
      version: 1,
    },
  }))
  on('state.set', (_d, e) => {
    const stored = unwrap(e.value)
    if (e.key === 'state') court = stored as DoubleUpState
    else interval = (stored as { interval: number }).interval
    return { value: { isSet: true } }
  })
  on('http.fetch', () => answer(404, null))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await drained.promise

  expect(court.matchId).toBe(undefined)
  expect(court.seats).toBe(null)
  // Nothing left to watch: each sleep waits longer than the first.
  expect(sleeps.length).toBeGreaterThanOrEqual(3)
  expect(sleeps[sleeps.length - 1]).toBeGreaterThan(sleeps[0])
})

test('the tools speak: say posts chat under the tool_use id, serve carries git refs', async ($, on) => {
  const gitAnswers: Record<string, string> = {
    'git remote get-url origin': 'git@github.com:acme/app.git',
    'git rev-parse --abbrev-ref HEAD': 'fix/billing',
    'git rev-parse HEAD': 'abc1234',
  }
  baseStubs(on, { process: argv => {
    if (argv in gitAnswers) return { exitCode: 0, stdout: `${gitAnswers[argv]}\n`, stderr: '' }
    if (argv.includes('origin')) return { exitCode: 0, stdout: 'git@github.com:acme/app.git\n', stderr: '' }
    return { exitCode: 1, stdout: '', stderr: '' }
  } })
  let court = seeded({
    token: 'tok-1', matchId: 9, matchState: 'live',
    seats: [seat('us', 'human', 'Sam'), { ...seat('us', 'agent', "Sam's agent"), id: 2 }],
  })
  const posts: string[] = []
  on('state.get', (_d, e) => ({
    value: {
      value: e.key === 'state'
        ? { shape: 'state-2', value: court }
        : { shape: 'poll-1', value: { interval: 3000 } },
      version: 1,
    },
  }))
  on('state.set', (_d, e) => {
    if (e.key === 'state') court = unwrap(e.value) as DoubleUpState
    return { value: { isSet: true } }
  })
  on('http.fetch', (_d, e) => {
    posts.push(`${String(e.url ?? '')} ${String((e.init as { body?: string } | undefined)?.body ?? '')}`)
    return answer(201, {})
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const said = await $.tool.call({ tool: 'mcp__doubleup__say', body: 'on it', tool_use_id: 'tu-1' })
  expect(JSON.stringify(said)).toContain('said')
  expect(posts.some(p => p.includes('/events') && p.includes('"kind":"chat"') && p.includes('"client_event_id":"tu-1"'))).toBe(true)

  const served = await $.tool.call({ tool: 'mcp__doubleup__serve', summary: 'fixed the loop', refs: [{ type: 'path', path: 'app/invoice.rb' }], tool_use_id: 'tu-2' })
  expect(JSON.stringify(served)).toContain('served')
  const servePost = posts.find(p => p.includes('"kind":"serve"'))
  expect(servePost).toContain('fix/billing')
  expect(servePost).toContain('abc1234')
  expect(servePost).toContain('app/invoice.rb')
})

test('status posts the event and bumps the seat line', async ($, on) => {
  baseStubs(on, { process: () => ({ exitCode: 1, stdout: '', stderr: '' }) })
  let court = seeded({
    token: 'tok-1', matchId: 9, matchState: 'live',
    seats: [seat('us', 'human', 'Sam'), { ...seat('us', 'agent', "Sam's agent"), id: 2 }],
  })
  const posts: string[] = []
  on('state.get', (_d, e) => ({
    value: {
      value: e.key === 'state'
        ? { shape: 'state-2', value: court }
        : { shape: 'poll-1', value: { interval: 3000 } },
      version: 1,
    },
  }))
  on('state.set', (_d, e) => {
    if (e.key === 'state') court = unwrap(e.value) as DoubleUpState
    return { value: { isSet: true } }
  })
  on('http.fetch', (_d, e) => {
    posts.push(`${String(e.url ?? '')} ${String((e.init as { body?: string } | undefined)?.body ?? '')}`)
    return answer(201, {})
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await $.tool.call({ tool: 'mcp__doubleup__status', text: 'chasing the flaky test', tool_use_id: 'tu-3' })
  expect(posts.some(p => p.includes('/seats/2') && p.includes('"status":"chasing the flaky test"'))).toBe(true)
  expect(posts.some(p => p.includes('"kind":"status"'))).toBe(true)
})

test('court answers with the digest the agent re-reads', async ($, on) => {
  baseStubs(on)
  let court = seeded({
    token: 'tok-1', matchId: 9, matchState: 'live', volleyCount: 2, rallyCap: 6,
    seats: [seat('us', 'human', 'Sam', 'github.com/acme/api')],
  })
  on('state.get', (_d, e) => ({
    value: {
      value: e.key === 'state'
        ? { shape: 'state-2', value: court }
        : { shape: 'poll-1', value: { interval: 3000 } },
      version: 1,
    },
  }))
  on('state.set', (_d, e) => {
    if (e.key === 'state') court = unwrap(e.value) as DoubleUpState
    return { value: { isSet: true } }
  })
  on('http.fetch', (_d, e) => {
    const url = String(e.url ?? '')
    if (url.includes('/events')) {
      return answer(200, {
        events: [{
          id: 30, kind: 'chat', body: 'ship it?', refs: [], side: 'them', role: 'human',
          name: 'Alex', to_side: null, client_event_id: 'c30', created_at: '2026-11-22T12:00:00Z',
        }],
        seats: [], volley_count: 2, rally_cap: 6, wake: false,
      })
    }
    return answer(200, MATCH_BODY(false))
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const out = await $.tool.call({ tool: 'mcp__doubleup__court' })
  const text = JSON.stringify(out)
  expect(text).toContain('Court 9 is waiting')
  expect(text).toContain('Repos: ours: github.com/acme/api')
  expect(text).toContain('ship it?')
})

test('compose injects each event once, then lists ids; status reminds on the cadence', async ($, on) => {
  baseStubs(on, { process: () => ({ exitCode: 0, stdout: 'main\n', stderr: '' }) })
  let court = seeded({
    token: 'tok-1', matchId: 9, matchState: 'live', volleyCount: 1, rallyCap: 6, turnCount: 4,
    seats: [seat('us', 'human', 'Sam', 'github.com/acme/api'), seat('them', 'human', 'Alex', 'github.com/acme/web')],
    inbox: [
      {
        id: 41, kind: 'chat', body: 'billing fix landed?', refs: [], side: 'them', role: 'human',
        name: 'Alex', to_side: null, client_event_id: 'c41', created_at: '2026-11-22T12:00:00Z',
      },
      {
        id: 43, kind: 'serve', body: 'pushed fix/billing', refs: [], side: 'them', role: 'agent',
        name: "Alex's agent", to_side: 'us', client_event_id: 's43', created_at: '2026-11-22T12:01:00Z',
      },
    ],
  })
  on('state.get', (_d, e) => ({
    value: {
      value: e.key === 'state'
        ? { shape: 'state-2', value: court }
        : { shape: 'poll-1', value: { interval: 3000 } },
      version: 1,
    },
  }))
  on('state.set', (_d, e) => {
    if (e.key === 'state') court = unwrap(e.value) as DoubleUpState
    return { value: { isSet: true } }
  })
  on('http.fetch', () => answer(304, null))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const facts = { tools: [], traits: [], surfaces: ['terminal'] }
  const first = await $.prompt.compose(facts)
  const firstText = JSON.stringify(first)
  expect(firstText).toContain('billing fix landed?')
  expect(firstText).toContain('Our repo: github.com/acme/api.')
  expect(firstText).toContain('Their repo: github.com/acme/web.')
  expect(firstText).toContain('git remote add them github.com/acme/web')
  expect(firstText).toContain('pushed fix/billing')
  expect(firstText).toContain('Call status()') // turn 5
  expect(court.injectedEventIds).toEqual([41, 43])
  expect(court.turnCount).toBe(5)

  // Turn 6: the same events are spent; only ids remain, and no reminder.
  const second = await $.prompt.compose(facts)
  const secondText = JSON.stringify(second)
  expect(secondText).not.toContain('billing fix landed?')
  expect(secondText).toContain('[balls waiting: 41, 43]')
  expect(secondText).not.toContain('Call status()')
})

test('a >> prompt goes to the court chat and is dropped from the model', async ($, on) => {
  baseStubs(on)
  let court = seeded({ token: 'tok-1', matchId: 9, matchState: 'live', seats: [seat('us', 'human', 'Sam')] })
  const posts: string[] = []
  on('state.get', (_d, e) => ({
    value: {
      value: e.key === 'state'
        ? { shape: 'state-2', value: court }
        : { shape: 'poll-1', value: { interval: 3000 } },
      version: 1,
    },
  }))
  on('state.set', (_d, e) => {
    if (e.key === 'state') court = unwrap(e.value) as DoubleUpState
    return { value: { isSet: true } }
  })
  on('http.fetch', (_d, e) => {
    posts.push(`${String(e.url ?? '')} ${String((e.init as { body?: string } | undefined)?.body ?? '')}`)
    return answer(201, {})
  })
  const fills: string[] = []
  on('prompt.fill', (_d, e) => {
    fills.push(`${e.text ?? ''}:${e.mode ?? 'replace'}`)
    return { isFilled: true }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const dropped = await $.prompt.submit({ text: '>> lunch in 10?' })
  expect(JSON.stringify(dropped)).toContain('drop')
  expect(posts.some(p => p.includes('"kind":"chat"') && p.includes('lunch in 10?'))).toBe(true)
  // A dropped prompt never enters, so the mod empties the box itself.
  expect(fills).toEqual([':replace'])

  const kept = await $.prompt.submit({ text: 'fix the login bug' })
  expect(posts.filter(p => p.includes('"kind":"chat"')).length).toBe(1)
  expect(JSON.stringify(kept)).not.toContain('drop')
})

test('a >> prompt that the court refuses stays in the prompt instead of being lost', async ($, on) => {
  const toasts: string[] = []
  baseStubs(on, { toast: (t: string) => { toasts.push(t) } })
  const court = seeded({ token: 'tok-1', matchId: 9, matchState: 'live', seats: [seat('us', 'human', 'Sam')] })
  on('state.get', (_d, e) => ({
    value: {
      value: e.key === 'state'
        ? { shape: 'state-2', value: court }
        : { shape: 'poll-1', value: { interval: 3000 } },
      version: 1,
    },
  }))
  on('state.set', () => ({ value: { isSet: true } }))
  on('http.fetch', () => answer(422, { error: 'Fault: that snippet looks like it contains a secret.' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const out = await $.prompt.submit({ text: '>> take a look at this snippet' })
  expect(JSON.stringify(out)).not.toContain('drop')
  expect(toasts.some(t => t.startsWith('Fault:'))).toBe(true)
})

test('ace with an empty summary is a fault, and a refused post says Fault', async ($, on) => {
  baseStubs(on)
  const court = seeded({
    token: 'tok-1', matchId: 9, matchState: 'live',
    seats: [seat('us', 'human', 'Sam'), { ...seat('us', 'agent', "Sam's agent"), id: 2 }],
  })
  on('state.get', (_d, e) => ({
    value: {
      value: e.key === 'state'
        ? { shape: 'state-2', value: court }
        : { shape: 'poll-1', value: { interval: 3000 } },
      version: 1,
    },
  }))
  on('state.set', () => ({ value: { isSet: true } }))
  on('http.fetch', () => answer(429, { error: 'slow_down' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const blank = await $.tool.call({ tool: 'mcp__doubleup__ace', summary: '', tool_use_id: 'tu-9' })
  expect(JSON.stringify(blank)).toContain('Fault: ace needs a summary to celebrate.')
  const refused = await $.tool.call({ tool: 'mcp__doubleup__ace', summary: 'suite is green', tool_use_id: 'tu-10' })
  expect(JSON.stringify(refused)).toContain('Fault: the ace did not land.')
})

test('the first compose on a fresh court does not nag for a status', async ($, on) => {
  baseStubs(on, { process: () => ({ exitCode: 0, stdout: 'main\n', stderr: '' }) })
  let court = seeded({
    token: 'tok-1', matchId: 9, matchState: 'live', turnCount: 0, lastBranch: null,
    seats: [seat('us', 'human', 'Sam'), { ...seat('us', 'agent', "Sam's agent"), id: 2 }],
  })
  on('state.get', (_d, e) => ({
    value: {
      value: e.key === 'state'
        ? { shape: 'state-2', value: court }
        : { shape: 'poll-1', value: { interval: 3000 } },
      version: 1,
    },
  }))
  on('state.set', (_d, e) => {
    if (e.key === 'state') court = unwrap(e.value) as DoubleUpState
    return { value: { isSet: true } }
  })
  on('http.fetch', () => answer(304, null))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const facts = { tools: [], traits: [], surfaces: ['terminal'] }
  const first = JSON.stringify(await $.prompt.compose(facts))
  expect(first).not.toContain('Call status()')
  expect(court.turnCount).toBe(1)
})

test('a serve across the net wakes the agent once, and stays silent at the cap', async ($, on) => {
  let court = seeded({
    token: 'tok-1', matchId: 9, matchState: 'live', volleyCount: 2, rallyCap: 4,
    seats: [seat('us', 'human', 'Sam'), { ...seat('us', 'agent', "Sam's agent"), id: 2 },
            { ...seat('them', 'human', 'Alex'), id: 3 }, { ...seat('them', 'agent', "Alex's agent"), id: 4 }],
  })
  const wakes: string[] = []
  const drained = gate<void>()
  let feedCount = 0
  baseStubs(on, {
    onSubmit: text => { if (text.startsWith('Ball from')) wakes.push(text) },
    sleep: () => {
      if (feedCount >= 3) {
        drained.resolve()
        return park()
      }
      return { value: {} }
    },
  })
  on('state.get', (_d, e) => ({
    value: {
      value: e.key === 'state'
        ? { shape: 'state-2', value: court }
        : { shape: 'poll-1', value: { interval: 100 } },
      version: 1,
    },
  }))
  on('state.set', (_d, e) => {
    if (e.key === 'state') court = unwrap(e.value) as DoubleUpState
    return { value: { isSet: true } }
  })
  const serveEv = (id: number, name: string) => ({
    id, kind: 'serve', body: `serve ${id}`, refs: [], side: 'them', role: 'agent',
    name, to_side: 'us', client_event_id: `s${id}`, created_at: '2026-11-22T12:00:00Z',
  })
  on('http.fetch', (_d, e) => {
    if (!String(e.url ?? '').includes('/events')) return answer(200, {})
    feedCount += 1
    if (feedCount === 1) return answer(200, { events: [serveEv(50, "Alex's agent")], seats: court.seats, volley_count: 2, rally_cap: 4, wake: true })
    if (feedCount === 2) return answer(200, { events: [serveEv(51, "Alex's agent")], seats: court.seats, volley_count: 4, rally_cap: 4, wake: false })
    return answer(304, null)
  })
  on('ui.invalidate', () => ({ value: {} }))
  on('ui.notify', () => ({ value: {} }))
  on('ui.panes', () => ({ value: [{ id: 'doubleup-court', title: 'Double Up court', isShown: true, isFocused: true }] }))
  on('audio.play', () => ({ value: {} }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await drained.promise

  // One wake for serve 50 while wake is true; serve 51 arrives at the cap
  // (wake false) and waits for the person instead.
  expect(wakes.length).toBe(1)
  expect(wakes[0]).toContain('Ball from')
  expect(court.wokenEventIds).toEqual([50, 51])
})

test('a serve while the pane is not focused notifies, and the pock is opt-in', async ($, on) => {
  let court = seeded({
    token: 'tok-1', matchId: 9, matchState: 'live', volleyCount: 1, rallyCap: 4,
    seats: [seat('us', 'human', 'Sam')],
  })
  const notes: string[] = []
  const pocks: number[] = []
  const drained = gate<void>()
  let feedCount = 0
  baseStubs(on, {
    sleep: () => {
      if (feedCount >= 2) {
        drained.resolve()
        return park()
      }
      return { value: {} }
    },
  })
  on('state.get', (_d, e) => ({
    value: {
      value: e.key === 'state'
        ? { shape: 'state-2', value: court }
        : { shape: 'poll-1', value: { interval: 100 } },
      version: 1,
    },
  }))
  on('state.set', (_d, e) => {
    if (e.key === 'state') court = unwrap(e.value) as DoubleUpState
    return { value: { isSet: true } }
  })
  on('http.fetch', (_d, e) => {
    if (!String(e.url ?? '').includes('/events')) return answer(200, {})
    feedCount += 1
    if (feedCount === 1) {
      return answer(200, {
        events: [{ id: 60, kind: 'serve', body: 'pushed fix/billing', refs: [], side: 'them', role: 'agent',
                   name: "Alex's agent", to_side: 'us', client_event_id: 's60', created_at: '2026-11-22T12:00:00Z' }],
        seats: court.seats, volley_count: 1, rally_cap: 4, wake: false,
      })
    }
    return answer(304, null)
  })
  on('ui.invalidate', () => ({ value: {} }))
  on('ui.notify', (_d, e) => { notes.push(String((e as { text?: unknown }).text ?? '')); return { value: {} } })
  on('ui.panes', () => ({ value: [] }))
  on('audio.play', (_d, e) => { pocks.push(1); return { value: {} } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await drained.promise

  expect(notes.some(n => n.includes('serve from'))).toBe(true)
  // pock defaults off: no sound until the person turns it on.
  expect(pocks.length).toBe(0)

  const out = textOf(await $.command.run({ command: 'doubleup', args: 'sound on' }))
  expect(out).toContain('sound')
})
