// The Double Up mod: login, the poll loop, the scoreboard band above the
// prompt, and the court pane. One register(on) entry point, wired from
// hooks/hooks.json.
//
// The engine only allows $ spelled as $.noun.event(...) at a call site, so
// every fetch, sleep, and state read lives directly inside a handler; the
// request builders, parsers, and state folds are plain functions in lib/.
// The state library scans this file, so the atoms stay here as consts.

import { atom, read, update } from 'claude-code'
import type { Dollar, Register } from 'claude-code'
import {
  applyFeed,
  authorizeRequest,
  baseUrl,
  bodyOf,
  feedRequest,
  parseAuthorizeResponse,
  parseFeedResponse,
  parseTokenResponse,
  tokenRequest,
} from '../lib/api'
import type { Feed, FeedResult, HttpRequest } from '../lib/api'
import {
  autoReturnRequest,
  isDroppedDraftRestore,
  chatRequest,
  courtDigestRequest,
  courtFromMatch,
  eventRequest,
  finishRequest,
  joinRequest,
  newClientId,
  parseCourtResult,
  parseJoinArg,
  parseServeTarget,
  presenceRequest,
  serveRequest,
  statusRequest,
} from '../lib/court'
import type { MatchJson } from '../lib/court'
import { buildCourtDigest, buildCourtSection } from '../lib/compose'
import { ACTIVE_MS, nextInterval } from '../lib/ladder'
import type { DoubleUpState, FeedEvent, SeatJson } from '../types/state'

const DEFAULT_STATE: DoubleUpState = {
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
}

// Change the shape tag when the stored fields change: it declines what an
// earlier version stored, which outlives a reload.
const state = atom({ plugin: 'doubleup', key: 'state' } as const, DEFAULT_STATE, { shape: 'state-2' })
const poll = atom({ plugin: 'doubleup', key: 'poll' } as const, { interval: ACTIVE_MS }, { shape: 'poll-1' })

export const COURT_PANE = 'doubleup-court'

type Next = (e: unknown) => unknown

let loopStarted = false

// The >> prompt the mod just dropped, so the engine's put-back of it can be
// recognized and emptied; cleared on the first match and left to expire.
let droppedDraft: { text: string; at: number } | null = null

function seatLine(seat: SeatJson): string {
  const mark = seat.role === 'human' ? '●' : '◆'
  return seat.status ? `${mark} ${seat.display_name} — ${seat.status}` : `${mark} ${seat.display_name}`
}

// One rally line: name, body, refs folded to chips, system lines dimmed.
function eventLine(ev: FeedEvent): string {
  if (ev.kind === 'system') return `· ${ev.body}`
  const tag = ev.kind === 'serve' ? 'serve ' : ev.kind === 'ace' ? 'ace ' : ''
  const refs = ev.refs.map(refLine).filter(Boolean).join(' ')
  const to = ev.to_side === 'them' ? ' → them' : ''
  return `${ev.name}${to}: ${tag}${ev.body}${refs ? `  ${refs}` : ''}`
}

// Refs stay compact: a branch/commit/path chip, never a pasted file.
function refLine(ref: { type: string } & Record<string, unknown>): string {
  if (ref.type === 'branch') return `⎇ ${String(ref.name ?? '')}`
  if (ref.type === 'commit') return `@${String(ref.sha ?? '').slice(0, 7)}`
  if (ref.type === 'path') return `▤ ${String(ref.path ?? '')}:${String(ref.range ?? '')}`
  if (ref.type === 'url') return String(ref.url ?? '')
  if (ref.type === 'snippet') return '▤ snippet folded'
  return ''
}

export const register: Register = on => {
  on('session.start', async ($: Dollar, e: unknown, next: Next) => {
    await $.command.register({
      name: 'doubleup',
      description: 'Double Up courts: serve, join, rally with a partner',
    })
    await $.tool.register({
      name: 'say',
      description: 'Speak to everyone on the court as a chat message.',
      inputSchema: { type: 'object', properties: { body: { type: 'string' } }, required: ['body'] },
    })
    await $.tool.register({
      name: 'serve',
      description: 'Return work over the net: a short summary plus refs. Push first; send refs, not files.',
      inputSchema: { type: 'object', properties: { summary: { type: 'string' }, refs: { type: 'array' } }, required: ['summary'] },
    })
    await $.tool.register({
      name: 'status',
      description: 'Post one line on what you are doing; it shows beside your name.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    })
    await $.tool.register({
      name: 'ace',
      description: 'Mark a clean win: a finished task the court should celebrate.',
      inputSchema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
    })
    await $.tool.register({
      name: 'court',
      description: 'Read the court again: seats, statuses, and the last 50 rally events.',
      inputSchema: { type: 'object', properties: {} },
    })
    if (!loopStarted) {
      loopStarted = true
      // The poll loop: sleep on the ladder, pull the feed, fold it in. One
      // dropped request or bad body must never kill it.
      void (async () => {
        for (;;) {
          try {
            await $.clock.sleep((await read($, poll)).interval)
            const s = await read($, state)
            if (!s.token || s.matchId === undefined) {
              // Nothing to watch: climb the ladder instead of spinning.
              await update($, poll, p => ({ interval: nextInterval(p.interval, false) }))
              continue
            }
            const req = feedRequest(baseUrl(), s.token, s.matchId, s.lastEventId)
            const res = await $.http.fetch(req.url, req.init)
            const out: FeedResult = parseFeedResponse(res.status, await bodyOf(res))
            if (out.kind === 'unauthorized') {
              await update($, state, st => ({ ...st, token: undefined }))
              $.ui.toast('Signed out of Double Up. Run /doubleup login.')
              continue
            }
            if (out.kind === 'gone') {
              await update($, state, st => ({ ...st, matchId: undefined, seats: null, matchState: null }))
              continue
            }
            if (out.kind === 'feed') {
              await update($, state, st => applyFeed(st, out.feed))
              if (out.feed.events.length > 0) {
                // A redrawn pane keeps the court feeling live even when the
                // person is only reading. Best effort: a failed nudge must
                // never cost the wake below.
                try {
                  await $.ui.invalidate('ui.render')
                } catch {}
                await reactToServe($, out.feed)
              }
            }
            const hadWork = out.kind === 'feed' && out.feed.events.length > 0
            await update($, poll, p => ({ interval: nextInterval(p.interval, hadWork) }))
          } catch {
            // A dropped request or a body that would not parse: hold the
            // pace and try again on the next tick.
          }
        }
      })()
    }
    return next(e)
  })

  on('command.run', { command: 'doubleup' }, async ($: Dollar, e: { args?: string }) => {
    const args = (e.args ?? '').trim()

    if (args === '' || args === 'login') {
      const base = baseUrl()
      const req = authorizeRequest(base)
      const res = await $.http.fetch(req.url, req.init)
      const az = parseAuthorizeResponse(res.status, await bodyOf(res), base)
      // Poll for the token in the background; the human approves on the
      // web. Bounded by wall clock, not iterations, so a short server
      // interval cannot end the wait early.
      void (async () => {
        const deadline = Date.now() + 15 * 60 * 1000
        while (Date.now() < deadline) {
          try {
            const treq = tokenRequest(base, az.device_code, 'claude-code')
            const tres = await $.http.fetch(treq.url, treq.init)
            const out = parseTokenResponse(tres.status, await bodyOf(tres))
            if (out.kind === 'token') {
              await update($, state, s => ({ ...s, token: out.token }))
              $.ui.toast('Ace. Double Up is in.')
              return
            }
            if (out.kind === 'expired') {
              $.ui.toast('That code ran out. Run /doubleup login again.')
              return
            }
          } catch {
            // A blip retries on the next tick.
          }
          await $.clock.sleep(az.interval * 1000)
        }
        $.ui.toast('That code ran out. Run /doubleup login again.')
      })()
      return {
        text: `Approve this device on the web:\n  ${az.verification_url}\nCode: ${az.user_code}`,
      }
    }

    if (args === 'logout') {
      await update($, state, s => ({ ...s, token: undefined }))
      return { text: 'Logged out. Revoke the device from the web settings page when you want it gone for good.' }
    }

    if (args === 'status') {
      const s = await read($, state)
      if (!s.token) return { text: 'Not logged in. Run /doubleup login.' }
      if (s.matchId === undefined) return { text: 'Signed in. No court joined yet.' }
      const where = s.matchState ? `Court ${s.matchId} is ${s.matchState}.` : `Court ${s.matchId} is fresh.`
      return { text: `Signed in. ${where} Rally ${s.volleyCount}/${s.rallyCap}` }
    }

    if (args.startsWith('serve')) {
      return serveCourt($, args.slice('serve'.length).trim())
    }
    if (args.startsWith('join')) {
      return joinCourt($, args.slice('join'.length).trim())
    }
    if (args === 'court') {
      const s = await read($, state)
      if (s.matchId === undefined) return { text: 'No court yet. Try /doubleup serve or /doubleup join.' }
      await $.ui.open({ id: COURT_PANE, title: 'Double Up court' })
      return { text: `Court ${s.matchId} opened.` }
    }
    if (args === 'auto on' || args === 'auto off') {
      const s = await read($, state)
      const mine = (s.seats ?? []).find(seat => seat.side === 'us' && seat.role === 'agent')
      if (!s.token || s.matchId === undefined || !mine) {
        return { text: 'No court yet, so no auto-return to set.' }
      }
      const autoOn = args === 'auto on'
      const req = autoReturnRequest(baseUrl(), s.token, s.matchId, mine.id, autoOn)
      await $.http.fetch(req.url, req.init)
      await update($, state, st => ({
        ...st,
        seats: (st.seats ?? []).map(one => (one.id === mine.id ? { ...one, auto_return: autoOn } : one)),
      }))
      return { text: autoOn ? 'Auto-return on: your agent answers serves itself.' : 'Auto-return off.' }
    }
    if (args === 'sound on' || args === 'sound off') {
      const sound = args === 'sound on'
      await update($, state, st => ({ ...st, pock: sound }))
      return { text: sound ? 'The ball has a sound.' : 'Sound off.' }
    }
    if (args === 'leave') {
      const s = await read($, state)
      const mine = (s.seats ?? []).find(seat => seat.side === 'us' && seat.role === 'human')
      if (s.token === undefined || s.matchId === undefined || !mine) {
        return { text: 'No court to leave.' }
      }
      const req = presenceRequest(baseUrl(), s.token, s.matchId, mine.id, false)
      await $.http.fetch(req.url, req.init)
      await update($, state, st => ({ ...st, matchId: undefined, mySeatId: undefined, seats: null, matchState: null, inbox: [] }))
      return { text: 'Left the court. The match keeps running for the others.' }
    }
    if (args === 'finish') {
      const s = await read($, state)
      if (!s.token || s.matchId === undefined) return { text: 'No court to finish.' }
      const req = finishRequest(baseUrl(), s.token, s.matchId)
      const res = await $.http.fetch(req.url, req.init)
      const out = parseCourtResult(res.status, await bodyOf(res))
      if (out.kind !== 'match') return { text: 'Fault: could not finish the match. Try again.' }
      await update($, state, st => ({ ...st, ...courtFromMatch(out.match) }))
      return { text: 'Match over.' }
    }

    return { text: 'Try: /doubleup login, serve, join, court, auto on|off, sound on|off, leave, finish, logout, status.' }
  })

  // A working turn means the person is at the net: keep the poll fast.
  on('turn.start', resetLadder)

  on('ui.render', { component: 'AbovePrompt' }, async ($: Dollar, e: unknown, next: Next) => {
    const s = await read($, state)
    if (!s.token || !s.seats || !s.matchState || s.matchState === 'finished') return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const us = s.seats.filter(seat => seat.side === 'us').map(seatLine).join('  ')
    const them = s.seats.filter(seat => seat.side === 'them').map(seatLine).join('  ')
    const ace = s.inbox.find(ev => ev.kind === 'ace' && ev.received_at !== undefined && Date.now() - ev.received_at < 10_000)
    return (
      <Box>
        <Text>{us}</Text>
        <Text dimColor>{them}</Text>
        <Text dimColor>{`Rally ${s.volleyCount}/${s.rallyCap} — ${s.matchState}`}</Text>
        {ace ? <Text backgroundColor="green">{`ACE — ${ace.body}`}</Text> : null}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: COURT_PANE }, renderCourtPane)

  on('tool.call', { tool: 'mcp__doubleup__say' }, sayTool)
  on('tool.call', { tool: 'mcp__doubleup__serve' }, serveTool)
  on('tool.call', { tool: 'mcp__doubleup__status' }, statusTool)
  on('tool.call', { tool: 'mcp__doubleup__ace' }, aceTool)
  on('tool.call', { tool: 'mcp__doubleup__court' }, courtTool)

  on('prompt.submit', interceptDoubleChat)
  // Engine-written prompt changes only: the put-back of a dropped >> draft.
  on('prompt.change', { origin: { kind: 'engine' } }, clearDroppedDraft)
  on('prompt.compose', composeCourt)
}

// The court pane: header, scoreboard, rally, chat input, auto-return toggle.
// Top level on purpose: the engine only accepts hooks named by a function
// declared at the top of the module.
async function renderCourtPane($: Dollar, e: unknown, next: Next): Promise<unknown> {
  const s = await read($, state)
  const base = baseUrl()
  const { Box, Text, Button, Input } = $.ui.resolve(e)

  if (s.matchId === undefined) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No court yet. Try /doubleup serve or /doubleup join.</Text>
      </Box>
    )
  }

  const us = (s.seats ?? []).filter(seat => seat.side === 'us')
  const them = (s.seats ?? []).filter(seat => seat.side === 'them')
  const repos = [
    us.find(seat => seat.repo_remote)?.repo_remote,
    them.find(seat => seat.repo_remote)?.repo_remote,
  ].filter(Boolean)
  const room = Math.max(4, ((e as { viewport?: { rows?: number } }).viewport?.rows ?? 24) - (repos.length > 0 ? 7 : 6))
  const rally = s.inbox.slice(-room).map(eventLine)
  const mine = us.find(seat => seat.role === 'agent')
  const autoLabel = mine?.auto_return ? 'Auto-return on' : 'Auto-return off'

  return (
    <Box flexDirection="column">
      <Text>{`court ${s.matchId} · ${s.matchState ?? 'fresh'} · Rally ${s.volleyCount}/${s.rallyCap}`}</Text>
      {repos.length > 0 && (
        <Text dimColor>{`repos: ${[...new Set(repos)].join(' ⇄ ')}`}</Text>
      )}
      <Text>{us.map(seatLine).join('  ')}</Text>
      <Text dimColor>{them.map(seatLine).join('  ')}</Text>
      {rally.map((line, i) => (
        <Text key={`r${i}`} dimColor={i < rally.length - 1}>{line}</Text>
      ))}
      <Box>
        <Input
          key="chat"
          placeholder="Say something to the court…"
          submitLabel="Send"
          onSubmit={(text: string) => sendChat($, s, base, text)}
        />
        {mine && (
          <Button
            key="auto"
            label={autoLabel}
            onPress={() => toggleAuto($, s, base, mine, !mine.auto_return)}
          />
        )}
      </Box>
    </Box>
  )
}

// The input closure posts a chat event from the human seat.
async function sendChat($: Dollar, s: DoubleUpState, base: string, text: string): Promise<void> {
  const trimmed = text.trim()
  if (!trimmed || s.token === undefined || s.matchId === undefined) return
  const req: HttpRequest = chatRequest(base, s.token, s.matchId, trimmed, newClientId('pane'))
  const res = await $.http.fetch(req.url, req.init)
  if (res.status !== 201) $.ui.toast('Fault: the court did not take that. Try again.')
}

// The toggle PATCHes the agent seat's auto_return.
async function toggleAuto($: Dollar, s: DoubleUpState, base: string, seat: SeatJson, on: boolean): Promise<void> {
  if (s.token === undefined || s.matchId === undefined) return
  const req = autoReturnRequest(base, s.token, s.matchId, seat.id, on)
  const res = await $.http.fetch(req.url, req.init)
  if (res.status !== 200) return
  await bodyOf(res)
  await update($, state, st => ({
    ...st,
    seats: (st.seats ?? []).map(one => (one.id === seat.id ? { ...one, auto_return: on } : one)),
  }))
}

// Serve opens a court: read the repo best-effort, create the match, open
// the pane in its waiting mode, and keep the seats in state.
async function serveCourt($: Dollar, arg: string): Promise<{ text: string }> {
  const s = await read($, state)
  if (!s.token) return { text: 'Not logged in. Run /doubleup login.' }
  const target = parseServeTarget(arg)
  const title = arg.trim() && target.kind === 'link' ? arg.trim() : 'New court'
  const repo = await gitOrigin($)
  const req = serveRequest(baseUrl(), s.token, title, repo.remote, target, 'claude-code')
  const res = await $.http.fetch(req.url, req.init)
  const out = parseCourtResult(res.status, await bodyOf(res))
  if (out.kind === 'refused') return { text: 'Fault: the court could not be created. Check the invite and try again.' }
  if (out.kind === 'not_found') return { text: 'Fault: we could not reach the court service. Try again.' }
  await update($, state, st => ({ ...st, ...courtFromMatch(out.match) }))
  await $.ui.open({ id: COURT_PANE, title: 'Double Up court' })
  const invite = out.inviteToken
    ? `Invite link: ${baseUrl()}/courts/${out.match.id}?invite=${out.inviteToken}`
    : target.kind === 'email'
      ? `Invite sent to ${target.email}.`
      : 'Invite created.'
  return { text: `Court ${out.match.id} is waiting. ${invite}` }
}

// Join takes a court id or a full invite link; the local repo rides along
// so both sides of the court know both repos.
async function joinCourt($: Dollar, arg: string): Promise<{ text: string }> {
  const s = await read($, state)
  if (!s.token) return { text: 'Not logged in. Run /doubleup login.' }
  const parsed = parseJoinArg(arg)
  if (!parsed) return { text: 'Try: /doubleup join 42 or /doubleup join <invite link>.' }
  const repo = await gitOrigin($)
  const req = joinRequest(baseUrl(), s.token, parsed.matchId, parsed.token, repo.remote)
  const res = await $.http.fetch(req.url, req.init)
  const out = parseCourtResult(res.status, await bodyOf(res))
  if (out.kind !== 'match') {
    return { text: 'Fault: that invite did not open a court. Check the link and try again.' }
  }
  await update($, state, st => ({ ...st, ...courtFromMatch(out.match) }))
  await $.ui.open({ id: COURT_PANE, title: 'Double Up court' })
  return { text: `Court ${out.match.id} joined. It is ${out.match.state}.` }
}

// The repo, best-effort: git facts are decoration, never a blocker.
async function gitOrigin($: Dollar): Promise<{ remote: string | null; branch: string | null; commit: string | null }> {
  try {
    const remote = await $.process.run(['git', 'remote', 'get-url', 'origin'])
    const branch = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'])
    const commit = await $.process.run(['git', 'rev-parse', 'HEAD'])
    return {
      remote: remote.exitCode === 0 ? String(remote.stdout).trim() : null,
      branch: branch.exitCode === 0 ? String(branch.stdout).trim() : null,
      commit: commit.exitCode === 0 ? String(commit.stdout).trim() : null,
    }
  } catch {
    return { remote: null, branch: null, commit: null }
  }
}

// A working session leans in: reset the ladder whenever a turn begins, so
// the court feels live while the person is at it.
async function resetLadder($: Dollar, e: unknown, next: Next): Promise<unknown> {
  await update($, poll, p => ({ interval: ACTIVE_MS }))
  return next(e)
}


// The >> shortcut: a prompt starting ">>" goes to the court as chat and
// never reaches the model.
async function interceptDoubleChat($: Dollar, e: unknown, next: Next): Promise<unknown> {
  const text = String((e as { text?: unknown }).text ?? '')
  if (!text.startsWith('>>')) return next(e)
  const body = text.slice(2).trim()
  const s = await read($, state)
  if (!body || s.token === undefined || s.matchId === undefined) return next(e)
  const req = chatRequest(baseUrl(), s.token, s.matchId, body, newClientId('say'))
  try {
    const res = await $.http.fetch(req.url, req.init)
    if (res.status !== 201) {
      $.ui.toast('Fault: the court did not take that. Try again.')
      return next(e)
    }
  } catch {
    return next(e)
  }
  $.ui.toast('Sent to the court.')
  // A dropped prompt never enters, so the box keeps the draft: clear it
  // ourselves now, and remember it — the engine may put it back after the
  // drop (the person's typing is never lost to a refusal), and that
  // restore write is emptied by the prompt.change hook below.
  droppedDraft = { text, at: Date.now() }
  await $.prompt.fill({ text: '' })
  return { drop: 'doubleup: the prompt went to the court chat' }
}

// The engine puts a dropped prompt back in the box: that restore write is a
// prompt.change from the engine itself. The >> chat already landed, so empty
// the box once more when it arrives.
async function clearDroppedDraft($: Dollar, e: unknown, next: Next): Promise<unknown> {
  const text = String((e as { text?: unknown }).text ?? '')
  if (isDroppedDraftRestore(text, droppedDraft, Date.now())) {
    droppedDraft = null
    await $.prompt.fill({ text: '' })
  }
  return next(e)
}

// One section per turn while a court is live: who is on it, what waits,
// and the rules of engagement. Fresh event bodies ride once; after that
// the model re-reads them through the court tool.
async function composeCourt($: Dollar, e: unknown, next: Next): Promise<unknown> {
  const s = await read($, state)
  if (s.matchId === undefined) return next(e)
  const repo = await gitOrigin($)
  const turnCount = s.turnCount + 1
  const branchChanged = repo.branch !== null && s.lastBranch !== null && repo.branch !== s.lastBranch
  const section = buildCourtSection(
    { ...s, turnCount },
    { statusReminder: turnCount % 5 === 0, branchChanged },
  )
  await update($, state, st => ({
    ...st,
    turnCount,
    lastBranch: repo.branch ?? st.lastBranch,
    injectedEventIds: section
      ? [...st.injectedEventIds, ...section.injectedIds].slice(-500)
      : st.injectedEventIds,
  }))
  if (!section) return next(e)
  return { sections: [{ id: 'doubleup-court', text: section.text, scope: 'session' }] }
}

// Chat in the agent's own voice.
async function sayTool($: Dollar, e: unknown): Promise<{ result: { content: { type: string; text: string }[] } }> {
  const body = String((e as { body?: unknown }).body ?? '').trim()
  if (!body) return { result: { content: [{ type: 'text', text: 'Fault: say needs a message to send.' }] } }
  const s = await read($, state)
  if (s.token === undefined || s.matchId === undefined) {
    return { result: { content: [{ type: 'text', text: 'No court joined.' }] } }
  }
  const id = String((e as { tool_use_id?: unknown }).tool_use_id ?? newClientId('say'))
  const req = chatRequest(baseUrl(), s.token, s.matchId, body, id)
  const res = await $.http.fetch(req.url, req.init)
  return { result: { content: [{ type: 'text', text: res.status === 201 ? 'said' : 'Fault: the court did not take that.' }] } }
}

// Serve over the net: refs pre-filled from git, plus whatever the agent named.
async function serveTool($: Dollar, e: unknown): Promise<{ result: { content: { type: string; text: string }[] } }> {
  const summary = String((e as { summary?: unknown }).summary ?? '').trim()
  const named = Array.isArray((e as { refs?: unknown }).refs) ? (e as { refs: unknown[] }).refs : []
  if (!summary) return { result: { content: [{ type: 'text', text: 'Fault: serve needs a summary to send.' }] } }
  const s = await read($, state)
  if (s.token === undefined || s.matchId === undefined) {
    return { result: { content: [{ type: 'text', text: 'No court joined.' }] } }
  }
  const repo = await gitOrigin($)
  const refs = [
    ...(repo.branch ? [{ type: 'branch', name: repo.branch }] : []),
    ...(repo.commit ? [{ type: 'commit', sha: repo.commit }] : []),
    ...named,
  ]
  const id = String((e as { tool_use_id?: unknown }).tool_use_id ?? newClientId('serve'))
  const req = eventRequest(baseUrl(), s.token, s.matchId, 'serve', summary, refs, id)
  const res = await $.http.fetch(req.url, req.init)
  return { result: { content: [{ type: 'text', text: res.status === 201 ? 'served' : 'Fault: the serve did not land.' }] } }
}

// A status event also bumps the seat's status line.
async function statusTool($: Dollar, e: unknown): Promise<{ result: { content: { type: string; text: string }[] } }> {
  const text = String((e as { text?: unknown }).text ?? '').trim()
  if (!text) return { result: { content: [{ type: 'text', text: 'Fault: status needs a line to post.' }] } }
  const s = await read($, state)
  const mine = (s.seats ?? []).find(seat => seat.side === 'us' && seat.role === 'agent')
  if (s.token === undefined || s.matchId === undefined || !mine) {
    return { result: { content: [{ type: 'text', text: 'No court joined.' }] } }
  }
  const id = String((e as { tool_use_id?: unknown }).tool_use_id ?? newClientId('status'))
  const bump = statusRequest(baseUrl(), s.token, s.matchId, mine.id, text)
  await $.http.fetch(bump.url, bump.init)
  const req = eventRequest(baseUrl(), s.token, s.matchId, 'status', text, [], id)
  const res = await $.http.fetch(req.url, req.init)
  return { result: { content: [{ type: 'text', text: res.status === 201 ? 'posted' : 'Fault: the status did not land.' }] } }
}

async function aceTool($: Dollar, e: unknown): Promise<{ result: { content: { type: string; text: string }[] } }> {
  const summary = String((e as { summary?: unknown }).summary ?? '').trim()
  if (!summary) return { result: { content: [{ type: 'text', text: 'Fault: ace needs a summary to celebrate.' }] } }
  const s = await read($, state)
  if (s.token === undefined || s.matchId === undefined) {
    return { result: { content: [{ type: 'text', text: 'No court joined.' }] } }
  }
  const id = String((e as { tool_use_id?: unknown }).tool_use_id ?? newClientId('ace'))
  const req = eventRequest(baseUrl(), s.token, s.matchId, 'ace', summary, [], id)
  const res = await $.http.fetch(req.url, req.init)
  return { result: { content: [{ type: 'text', text: res.status === 201 ? 'ace' : 'Fault: the ace did not land.' }] } }
}

// Re-read after a compaction: the match row plus the recent rally.
async function courtTool($: Dollar): Promise<{ result: { content: { type: string; text: string }[] } }> {
  const s = await read($, state)
  if (s.token === undefined || s.matchId === undefined) {
    return { result: { content: [{ type: 'text', text: 'No court joined.' }] } }
  }
  const req = courtDigestRequest(baseUrl(), s.token, s.matchId)
  const res = await $.http.fetch(req.url, req.init)
  const out = parseCourtResult(res.status, await bodyOf(res))
  if (out.kind !== 'match') {
    return { result: { content: [{ type: 'text', text: 'Fault: the court could not be read. Try again.' }] } }
  }
  const match: MatchJson = out.match
  // The API only pages forward, so aim the cursor just below the last 50
  // events instead of reading from zero.
  const after = Math.max(0, s.lastEventId - 50)
  const feedReq = feedRequest(baseUrl(), s.token, s.matchId, after)
  const feedRes = await $.http.fetch(feedReq.url, feedReq.init)
  const feed = parseFeedResponse(feedRes.status, await bodyOf(feedRes))
  const digest = buildCourtDigest(match, match.seats, feed.kind === 'feed' ? feed.feed.events : s.inbox)
  return { result: { content: [{ type: 'text', text: digest }] } }
}


// A serve crossed the net: hand the ball to the agent (one prompt per serve,
// never at the cap), and let the person hear about it when they are away.
async function reactToServe($: Dollar, feed: Feed): Promise<void> {
  const s = await read($, state)
  const agentSeat = (feed.seats ?? []).find(seat => seat.side === 'us' && seat.role === 'agent')
  const ours = agentSeat ?? (s.seats ?? []).find(seat => seat.side === 'us' && seat.role === 'agent')

  for (const ev of feed.events) {
    const forUs = ev.kind === 'serve' && ev.side === 'them'
    if (!forUs) continue

    const already = s.wokenEventIds.includes(ev.id)
    await update($, state, st => ({
      ...st,
      wokenEventIds: already ? st.wokenEventIds : [...st.wokenEventIds, ev.id].slice(-100),
    }))

    if (!already && ours && feed.wake) {
      // The server only answers wake true below the cap and while
      // auto-return is on: at Deuce the ball waits for a person. If the
      // prompt could not enter the session, at least ring the bell.
      try {
        await $.prompt.submit({ text: `Ball from ${ev.name}: ${ev.body} Return it.` })
      } catch {
        $.ui.notify(`Double Up serve from ${ev.name}: ${ev.body}`)
      }
    }
  }

  const serve = feed.events.find(ev => ev.kind === 'serve' && ev.side === 'them')
  if (serve) {
    const { away, paneShown } = await awayFromUi($)
    if (away) {
      $.ui.notify(`Double Up serve from ${serve.name}: ${serve.body}`)
      if (s.pock && !paneShown) await $.audio.play({ asset: 'assets/pock.wav' })
    }
  }
}

// The pane is enough company when it is up: notify when nothing of ours is
// focused, and play the sound only when the pane is not shown at all.
async function awayFromUi($: Dollar): Promise<{ away: boolean; paneShown: boolean }> {
  try {
    const panes = await $.ui.panes()
    const ours = Array.isArray(panes) ? panes.filter(pane => typeof pane?.id === 'string' && pane.id === COURT_PANE) : []
    return {
      away: ours.length === 0 || !ours.some(pane => pane.isFocused),
      paneShown: ours.some(pane => pane.isShown),
    }
  } catch {
    return { away: true, paneShown: false }
  }
}
