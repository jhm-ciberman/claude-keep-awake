import type { AgentInfo, EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register, Timer } from 'claude-code'

import type { KeepAwakeLease, KeepAwakeLeases } from '../types'

/**
 * The status line text shown while the machine is held awake, before the reason.
 */
export const AWAKE_STATUS = '☕ awake'

/**
 * The full name the model calls the lease tool by.
 */
export const LEASE_TOOL = 'mcp__keep-awake__keep_awake'

/**
 * How long the machine stays awake after a turn ends.
 */
export const GRACE_MS = 5 * 60_000

/**
 * How long a loop waiting on a permission question keeps the machine awake.
 */
export const PERMISSION_WAIT_MS = 15 * 60_000

/**
 * How long a check-in that has not reached Claude keeps the machine awake.
 */
export const CHECK_IN_WAIT_MS = 15 * 60_000

/**
 * How many times a check-in is sent when its turn keeps dying on an error.
 */
export const CHECK_IN_TRIES = 3

/**
 * The longest lease Claude can take in one call, in minutes.
 */
export const MAX_LEASE_MINUTES = 240

/**
 * How often the leases are checked for their end.
 */
const TICK_MS = 60_000

/**
 * What marks a check-in message.
 */
export const CHECK_IN_MARKER = '[keep-awake]'

/**
 * The message sent to Claude when its own lease ends.
 */
export const CLAUDE_CHECK_IN_TEXT = `${CHECK_IN_MARKER} Your keep-awake lease has ended. If your work is still running, call keep_awake to renew it. If it is done, do nothing: 5 minutes after this turn ends, the PC goes back to its normal sleep timer.`

/**
 * The message sent to an agent when its own lease ends.
 */
export const AGENT_CHECK_IN_TEXT = `${CHECK_IN_MARKER} Your keep-awake lease has ended. If your work is still running, call keep_awake to renew it within 5 minutes. If it is done, do nothing.`

/**
 * The message sent to Claude when the user's `/awake` time ends.
 */
export const PERSON_CHECK_IN_TEXT = `${CHECK_IN_MARKER} The user's /awake time has ended. If you have work running, call keep_awake so the PC does not sleep. If not, do nothing: 5 minutes after this turn ends, the PC goes back to its normal sleep timer.`

const PROMPT_SECTION = `# Keep awake
The user may walk away while you work. If the PC goes to sleep, your work stops.
- While your turn runs, the PC stays awake by itself.
- After your turn ends, it stays awake 5 more minutes. Then it can sleep.
- So, before you end a turn while work is still running (a background command or agent, a workflow, a /loop or wakeup), call keep_awake. Set minutes to how long the work may take.
- When that time runs out, you get a message that starts with ${CHECK_IN_MARKER}. If the work is still running, call keep_awake again.
- When the work is done, call keep_awake with minutes 0.`

const LEASES = { plugin: 'keep-awake', key: 'leases' } as const

/**
 * Holds a "system required" power request for as long as it runs: Windows does not sleep,
 * but the display still turns off on its own timer.
 */
// The heartbeat is what ends an orphan: once Claude Code is gone the pipe breaks, the write
// fails, and the process exits, releasing the request with it. It writes through WriteFile
// because .NET's console stream silently ignores a broken pipe.
const HOLDER_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -Namespace KeepAwake -Name Native -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);
[DllImport("kernel32.dll")] public static extern System.IntPtr GetStdHandle(int handle);
[DllImport("kernel32.dll")] public static extern bool WriteFile(System.IntPtr file, byte[] buffer, uint length, out uint written, System.IntPtr overlapped);
'@
[void][KeepAwake.Native]::SetThreadExecutionState([uint32]2147483649) # ES_CONTINUOUS | ES_SYSTEM_REQUIRED
$stdout = [KeepAwake.Native]::GetStdHandle(-11)
$heartbeat = [Text.Encoding]::ASCII.GetBytes("awake\`n")
$written = [uint32]0
while ([KeepAwake.Native]::WriteFile($stdout, $heartbeat, $heartbeat.Length, [ref]$written, [IntPtr]::Zero)) {
    Start-Sleep -Seconds 5
}
`

/**
 * The command that starts the holder, from native Windows and from WSL alike.
 */
export const HOLDER_ARGV = [
  'powershell.exe',
  '-NoProfile',
  '-NonInteractive',
  '-EncodedCommand',
  encodeCommand(HOLDER_SCRIPT),
] as const

/**
 * Encodes a script the way PowerShell's `-EncodedCommand` reads it: UTF-16LE, then base64.
 */
function encodeCommand(script: string): string {
  let bytes = ''

  for (let i = 0; i < script.length; i++) {
    const unit = script.charCodeAt(i)
    bytes += String.fromCharCode(unit & 0xff, unit >> 8)
  }

  return btoa(bytes)
}

type Holder = HookStream<ProcessSpawnChunk, ProcessSpawnResult>

/**
 * A check-in message sent to Claude that has not reached it yet.
 */
type CheckIn = {
  text: string
  queuedAt: number
}

let holder: Holder | undefined
let ticker: Timer | undefined
let isWindowsHost: boolean | undefined
let isMainTurnRunning = false
// Running subagent turns, by turn id, to the agent each runs in.
const agentTurns = new Map<string, string>()
// Agents whose latest turn has ended.
const finishedAgents = new Set<string>()
// Permission questions still open, by tool_use_id: when each was asked and in which loop.
const asks = new Map<string, { at: number, agentId: string | undefined }>()
let leases: KeepAwakeLeases = { agents: {}, graceUntil: 0 }
const pendingCheckIns = new Set<CheckIn>()
// Main turns that a check-in started, by turn id, to the check-in's text.
const checkInTurns = new Map<string, string>()
const checkInFailures = new Map<string, number>()
const checkInRetries = new Set<Timer>()

/**
 * Whether this session runs on Windows or inside WSL, where Windows is the host to keep awake.
 */
async function runsOnWindows($: EngineInterface): Promise<boolean> {
  isWindowsHost ??= (await $.env.get('OS')) === 'Windows_NT'
    || (await $.env.get('WSL_DISTRO_NAME')) !== undefined

  return isWindowsHost
}

/**
 * Writes a span of time the short way: `2h 10m`, `24m`, `<1m`.
 */
function formatSpan(ms: number): string {
  const minutes = Math.floor(ms / 60_000)

  if (minutes < 1) {
    return '<1m'
  }

  const hours = Math.floor(minutes / 60)

  return hours === 0 ? `${minutes}m` : `${hours}h ${minutes % 60}m`
}

/**
 * Reads a duration the user typed (`90`, `45m`, `2h`, `1h30m`) as milliseconds.
 */
export function parseDuration(text: string): number | undefined {
  const match = /^(?:(\d+)h)?\s*(?:(\d+)m?)?$/i.exec(text.trim())

  if (match === null || (match[1] === undefined && match[2] === undefined)) {
    return undefined
  }

  const ms = (Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0)) * 60_000

  return ms > 0 ? ms : undefined
}

/**
 * Whether a lease still holds at `now`.
 */
function holds(lease: KeepAwakeLease | undefined, now: number): lease is KeepAwakeLease {
  return lease !== undefined && (lease.until === undefined || lease.until > now)
}

/**
 * Every lease Claude holds at `now`, the main conversation's and the agents'.
 */
function claudeLeases(now: number): KeepAwakeLease[] {
  return [leases.claude, ...Object.values(leases.agents)]
    .filter((lease): lease is KeepAwakeLease => holds(lease, now))
}

/**
 * Says which leases are held besides the caller's, or undefined when there are none.
 */
function describeOtherLeases(agentId: string | undefined, now: number): string | undefined {
  const others = Object.entries(leases.agents)
    .filter(([id, lease]) => id !== agentId && holds(lease, now))
    .map(([, lease]) => lease)

  if (agentId !== undefined && holds(leases.claude, now)) {
    others.unshift(leases.claude)
  }

  if (others.length === 0) {
    return undefined
  }

  const list = others.map(lease => `${lease.reason ?? 'no reason given'} (${formatSpan((lease.until ?? now) - now)})`)

  return `${others.length} other ${others.length === 1 ? 'lease still holds' : 'leases still hold'}: ${list.join(', ')}.`
}

/**
 * Whether an agent's run is over, by what the engine lists about it.
 */
function hasEnded(agentId: string, listed: AgentInfo[]): boolean {
  const agent = listed.find(candidate => candidate.id === agentId)

  // The engine does not list every agent, and drops the ones it lists a while after they end.
  if (agent === undefined) {
    return finishedAgents.has(agentId)
  }

  return agent.status === 'completed' || agent.status === 'failed' || agent.status === 'killed'
}

/**
 * The session's agents, when any agent holds a lease to check them against.
 */
async function listLeasingAgents($: EngineInterface): Promise<AgentInfo[]> {
  if (Object.keys(leases.agents).length === 0) {
    return []
  }

  try {
    return await $.agent.list()
  } catch (error) {
    $.ui.log(`keep-awake: the agents were not listed: ${String(error)}`, { to: 'debug' })

    return []
  }
}

/**
 * Whether the loop has had a permission question open for too long to count as working.
 */
function isStuckOnQuestion(agentId: string | undefined, now: number): boolean {
  return [...asks.values()].some(ask => ask.agentId === agentId && now - ask.at >= PERMISSION_WAIT_MS)
}

/**
 * Why the machine is held awake now, as the status line shows it, or undefined when it may sleep.
 */
function reasonToHold(now: number): string | undefined {
  const { person } = leases

  if (holds(person, now)) {
    return person.until === undefined
      ? `${AWAKE_STATUS} (you, until /awake off)`
      : `${AWAKE_STATUS} (you, ${formatSpan(person.until - now)} left)`
  }

  const held = claudeLeases(now)
  const [first] = held

  if (first !== undefined) {
    const longest = Math.max(...held.map(lease => lease.until ?? now))
    const what = held.length > 1
      ? `${held.length} leases`
      : first.reason === undefined ? 'Claude' : `Claude: ${first.reason}`

    return `${AWAKE_STATUS} (${what}, ${formatSpan(longest - now)} left)`
  }

  const isMainStuck = isStuckOnQuestion(undefined, now)

  if (pendingCheckIns.size > 0 && !isMainStuck) {
    return `${AWAKE_STATUS} (lease ended, telling Claude)`
  }

  if (isMainTurnRunning && !isMainStuck) {
    return AWAKE_STATUS
  }

  if ([...agentTurns.values()].some(agentId => !isStuckOnQuestion(agentId, now))) {
    return `${AWAKE_STATUS} (agent working)`
  }

  if (leases.graceUntil > now) {
    return `${AWAKE_STATUS} (${formatSpan(leases.graceUntil - now)} grace)`
  }

  return undefined
}

/**
 * Keeps the leases in the session's state, where a reload of the mod finds them.
 */
function save($: EngineInterface): void {
  // The round trip drops the fields left undefined, which state does not take.
  const value = JSON.parse(JSON.stringify(leases)) as KeepAwakeLeases

  void $.state.set(LEASES, value).catch(error => {
    $.ui.log(`keep-awake: the leases were not saved: ${String(error)}`, { to: 'debug' })
  })
}

/**
 * Starts the grace time from `now`, unless one already runs longer.
 */
function startGrace($: EngineInterface, now: number): void {
  leases.graceUntil = Math.max(leases.graceUntil, now + GRACE_MS)
  save($)
}

/**
 * Removes the leases of agents that have ended, and tells the living agents whose time ran out.
 */
function settleAgentLeases($: EngineInterface, listed: AgentInfo[], now: number): void {
  for (const [agentId, lease] of Object.entries(leases.agents)) {
    if (hasEnded(agentId, listed)) {
      delete leases.agents[agentId]
      save($)
    } else if (!holds(lease, now)) {
      delete leases.agents[agentId]
      startGrace($, now)
      tellAgent($, agentId)
    }
  }
}

/**
 * Tells an agent that its lease ended.
 */
function tellAgent($: EngineInterface, agentId: string): void {
  const logFailure = (why: string) => $.ui.log(`keep-awake: agent ${agentId} was not told: ${why}`, { to: 'debug' })

  $.session.send({ to: { agentId }, text: AGENT_CHECK_IN_TEXT }).then(
    result => result.isDelivered ? undefined : logFailure(result.reason),
    error => logFailure(String(error)),
  )
}

/**
 * Brings the holder, the status line and the check-ins in line with the leases.
 */
async function refresh($: EngineInterface): Promise<void> {
  if (!(await runsOnWindows($))) {
    return
  }

  const listed = await listLeasingAgents($)
  const now = await $.clock.now()

  settleAgentLeases($, listed, now)

  if (leases.claude !== undefined && !holds(leases.claude, now)) {
    leases.claude = undefined
    save($)
    checkIn($, CLAUDE_CHECK_IN_TEXT, now)
  }

  if (leases.person !== undefined && !holds(leases.person, now)) {
    leases.person = undefined
    save($)
    checkIn($, PERSON_CHECK_IN_TEXT, now)
  }

  for (const pending of pendingCheckIns) {
    if (now - pending.queuedAt >= CHECK_IN_WAIT_MS) {
      pendingCheckIns.delete(pending)
    }
  }

  const status = reasonToHold(now)

  if (status === undefined) {
    ticker?.cancel()
    ticker = undefined
    release()
    $.ui.status(undefined)

    return
  }

  ticker ??= $.clock.every(TICK_MS, () => void refresh($))
  void hold($)
  $.ui.status(status)
}

/**
 * Tells Claude a lease ended, and holds the machine awake until the message reaches it.
 */
function checkIn($: EngineInterface, text: string, now: number): void {
  const pending: CheckIn = { text, queuedAt: now }
  pendingCheckIns.add(pending)

  const fail = async (why: string) => {
    $.ui.log(`keep-awake: the check-in was not sent: ${why}`, { to: 'debug' })

    if (pendingCheckIns.delete(pending)) {
      startGrace($, await $.clock.now())
      await refresh($)
    }
  }

  $.prompt.submit({ text }).then(
    result => 'drop' in result ? fail(String(result.drop)) : undefined,
    error => fail(String(error)),
  )
}

/**
 * Sends a check-in again a while after its turn died on an error, so Claude gets a real
 * chance to answer, until it has been sent `CHECK_IN_TRIES` times.
 */
async function retryCheckIn($: EngineInterface, text: string): Promise<void> {
  const failures = (checkInFailures.get(text) ?? 0) + 1

  if (failures >= CHECK_IN_TRIES) {
    checkInFailures.delete(text)

    return
  }

  checkInFailures.set(text, failures)

  // Stands in for the next send while the retry waits, so the machine stays awake meanwhile.
  const waiting: CheckIn = { text, queuedAt: await $.clock.now() }
  pendingCheckIns.add(waiting)

  const retry = $.clock.after(GRACE_MS, () => {
    checkInRetries.delete(retry)

    if (pendingCheckIns.delete(waiting)) {
      void $.clock.now().then(now => checkIn($, text, now))
    }
  })
  checkInRetries.add(retry)
}

/**
 * Drops every check-in not yet delivered, for when the user or Claude has said the work is done.
 */
function cancelCheckIns(): void {
  pendingCheckIns.clear()
  checkInFailures.clear()

  for (const retry of checkInRetries) {
    retry.cancel()
  }

  checkInRetries.clear()
}

/**
 * Starts holding the machine awake, unless it already is.
 */
async function hold($: EngineInterface): Promise<void> {
  if (holder !== undefined) {
    return
  }

  const child = $.process.spawn({ argv: HOLDER_ARGV })
  holder = child

  try {
    // Leaving the loop kills the child; a heartbeat comes every few seconds to check.
    for await (const _ of child) {
      if (holder !== child) {
        break
      }
    }
  } catch (error) {
    $.ui.log(`keep-awake: the holder failed: ${String(error)}`, { to: 'debug' })
  } finally {
    if (holder === child) {
      release()
      $.ui.status(undefined)
    }
  }
}

/**
 * Lets the machine sleep again.
 */
function release(): void {
  holder = undefined
}

/**
 * Sets or ends the lease of the calling loop, `agentId` being absent for the main conversation,
 * and says what it now is and which others are held.
 */
async function lease($: EngineInterface, agentId: string | undefined, minutes: number, reason: string | undefined): Promise<string> {
  const now = await $.clock.now()

  if (minutes <= 0) {
    if (agentId === undefined) {
      leases.claude = undefined
      cancelCheckIns()
    } else {
      delete leases.agents[agentId]
    }

    save($)
    await refresh($)

    return `Lease ended. ${describeOtherLeases(agentId, now) ?? 'The PC can sleep once nothing else keeps it awake.'}`
  }

  const capped = Math.min(minutes, MAX_LEASE_MINUTES)
  const taken = { until: now + capped * 60_000, reason }

  if (agentId === undefined) {
    leases.claude = taken
  } else {
    leases.agents[agentId] = taken
  }

  save($)
  await refresh($)

  const answer = `The PC stays awake for ${capped} ${capped === 1 ? 'minute' : 'minutes'}. You will get a message when it ends.`
  const others = describeOtherLeases(agentId, now)

  return others === undefined ? answer : `${answer} ${others}`
}

/**
 * Answers `/awake` with its arguments.
 */
async function command($: EngineInterface, args: string): Promise<string> {
  const word = args.trim().toLowerCase()
  const now = await $.clock.now()

  if (word === 'on') {
    leases.person = {}
  } else if (word === 'off') {
    leases.person = undefined
    leases.claude = undefined
    leases.agents = {}
    cancelCheckIns()
  } else if (word !== '' && word !== 'status') {
    const ms = parseDuration(word)

    if (ms === undefined) {
      return 'Usage: /awake [on | off | 30m | 2h | 1h30m]'
    }

    leases.person = { until: now + ms }
  }

  save($)
  await refresh($)

  return reasonToHold(now) ?? '💤 Nothing keeps the PC awake. It sleeps on its normal timer.'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)

    if (!(await runsOnWindows($))) {
      return started
    }

    await $.tool.register({
      name: 'keep_awake',
      description: 'Keeps the PC awake for a number of minutes, so work that outlives this turn is not stopped by sleep. Each agent has its own lease: calling it again replaces your own time, and minutes 0 ends your own lease. The answer lists the leases other agents hold.',
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          minutes: { type: 'integer', minimum: 0, maximum: MAX_LEASE_MINUTES, description: 'How long to stay awake. 0 lets the PC sleep.' },
          reason: { type: 'string', description: 'A few words on what is running, shown in the status line.' },
        },
        required: ['minutes'],
      },
    })
    await $.command.register({
      name: 'awake',
      description: 'Keep the PC awake: on, off, or a time like 2h',
      argumentHint: '[on | off | 2h]',
      immediate: true,
    })

    // After a reload of the mod, the leases come back, and a turn that may be running gets the grace time.
    const { value } = await $.state.get(LEASES)

    if (value !== undefined) {
      leases = { ...value, agents: value.agents ?? {} }
      startGrace($, await $.clock.now())
      await refresh($)
    }

    return started
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)

    if (!(await runsOnWindows($))) {
      return composed
    }

    return { sections: [...composed.sections, { id: 'keep-awake:lease', text: PROMPT_SECTION, scope: 'session' }] }
  })

  on('tool.call', { tool: LEASE_TOOL }, async ($, e) => {
    const input = e as { minutes?: unknown, reason?: unknown, agentId?: string }
    const minutes = typeof input.minutes === 'number' ? input.minutes : Number(input.minutes)

    if (!Number.isFinite(minutes)) {
      return { deny: 'minutes must be a number.' }
    }

    const reason = typeof input.reason === 'string' && input.reason.trim() !== '' ? input.reason.trim() : undefined

    return { result: await lease($, input.agentId, minutes, reason) }
  })

  on('command.run', { command: 'awake' }, async ($, e) => ({ text: await command($, e.args) }))

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)

    if (verdict.decision === 'ask' && e.tool_use_id !== undefined) {
      asks.set(e.tool_use_id, { at: await $.clock.now(), agentId: e.agentId })
    }

    return verdict
  })

  on('tool.call', async ($, e, next) => {
    // A call the model makes means its turn runs, which a reload of the mod may have missed.
    if (e.agentId === undefined && next.origin.plugin === 'engine' && !isMainTurnRunning) {
      isMainTurnRunning = true
      void refresh($)
    }

    try {
      return await next(e)
    } finally {
      // The question is settled once the call ends, whether the user allowed it or not.
      if (asks.delete(e.tool_use_id)) {
        void refresh($)
      }
    }
  })

  on('turn.start', async ($, e, next) => {
    const started = await next(e)

    if (e.agentId !== undefined) {
      agentTurns.set(e.turnId, e.agentId)
      finishedAgents.delete(e.agentId)
    } else {
      isMainTurnRunning = true

      for (const pending of pendingCheckIns) {
        if (e.text.includes(pending.text)) {
          pendingCheckIns.delete(pending)
          checkInTurns.set(e.turnId, pending.text)
        }
      }
    }

    void refresh($)

    return started
  })

  on('turn.complete', async ($, e, next) => {
    const completed = await next(e)

    if (e.agentId !== undefined) {
      agentTurns.delete(e.turnId)
      finishedAgents.add(e.agentId)

      for (const [id, ask] of asks) {
        if (ask.agentId === e.agentId) {
          asks.delete(id)
        }
      }

      void refresh($)

      return completed
    }

    isMainTurnRunning = false

    for (const [id, ask] of asks) {
      if (ask.agentId === undefined) {
        asks.delete(id)
      }
    }

    startGrace($, await $.clock.now())

    const text = checkInTurns.get(e.turnId)

    if (text !== undefined) {
      checkInTurns.delete(e.turnId)

      if (e.reason === 'error') {
        await retryCheckIn($, text)
      } else {
        checkInFailures.delete(text)
      }
    }

    void refresh($)

    return completed
  })

  on('session.end', async ($, e, next) => {
    isMainTurnRunning = false
    agentTurns.clear()
    asks.clear()
    checkInTurns.clear()

    // A /clear starts a new conversation in the same process: the leases carry on into it.
    if (e.reason === 'clear') {
      await refresh($)

      return next(e)
    }

    leases = { agents: {}, graceUntil: 0 }
    finishedAgents.clear()
    cancelCheckIns()
    ticker?.cancel()
    ticker = undefined
    release()
    $.ui.status(undefined)

    return next(e)
  })
}
