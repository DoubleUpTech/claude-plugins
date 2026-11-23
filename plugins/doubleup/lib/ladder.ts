// The poll ladder: fast while the court is live and the session is working,
// slower when nothing arrives, so an idle session stays off the server.

export const ACTIVE_MS = 3000
export const LADDER = [ACTIVE_MS, 15000, 60000] as const

export function nextInterval(current: number, hadWork: boolean): number {
  if (hadWork) return ACTIVE_MS
  const next = LADDER.find(ms => ms > current)
  return next ?? LADDER[LADDER.length - 1]
}
