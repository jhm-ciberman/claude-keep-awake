import type { AgentStatus, CommandRunInput, On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import {
  AGENT_CHECK_IN_TEXT,
  AWAKE_STATUS,
  CHECK_IN_WAIT_MS,
  CLAUDE_CHECK_IN_TEXT,
  GRACE_MS,
  HOLDER_ARGV,
  LEASE_TOOL,
  PERMISSION_WAIT_MS,
  PERSON_CHECK_IN_TEXT,
  parseDuration,
} from '../hooks/register.ts'

const MINUTE = 60_000

/**
 * Room for the tests that move the clock a long way, one timer tick at a time.
 */
const LONG = { timeoutMs: 30_000 }

/**
 * Stands in for the engine beneath the mod: answers turns, tools and commands, records the
 * status line, the prompts submitted and the holders spawned, and runs each holder until the
 * mod leaves its loop. `submit` says what becomes of each prompt the mod submits: it enters
 * the queue, the call is refused, or it is dropped.
 */
function fakeEngine(on: On, env: Record<string, string>, submit: 'enter' | 'refuse' | 'drop' = 'enter') {
  const clock = mock.clock(on)
  const statuses: (string | undefined)[] = []
  const spawned: (readonly string[])[] = []
  const prompts: string[] = []
  const agents = new Map<string, AgentStatus>()
  const sent: { to: unknown, text: string }[] = []
  let running = 0

  mock.env(on, env)
  on('agent.list', () => ({
    value: [...agents].map(([id, status]) => ({ id, status, description: '', type: 'general-purpose' })),
  }) as never)
  on('session.send', ($, e) => {
    sent.push({ to: e.to, text: e.text })

    return { isDelivered: true }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__keep-awake__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('prompt.submit', ($, e) => {
    if (submit === 'refuse') {
      throw new Error('no prompt here')
    }

    if (submit === 'drop') {
      return { drop: 'a hook dropped it' }
    }

    prompts.push(e.text)

    return { text: e.text }
  })
  // The kit's bottom for a call with no result takes { value }, which the types do not show.
  on('ui.log', () => ({ value: undefined }) as never)
  on('ui.status', ($, e) => {
    statuses.push(e.text)

    return { value: undefined } as never
  })
  on('process.spawn', async function* ($, e) {
    spawned.push(e.argv)
    running++

    try {
      while (true) {
        yield { stream: 'stdout' as const, text: 'awake\n' }
        await clock.sleep(5000)
      }
    } finally {
      running--
    }
  })

  return {
    clock,
    statuses,
    spawned,
    prompts,
    agents,
    sent,
    running: () => running,
    status: () => statuses.at(-1),
  }
}

/**
 * Runs `/awake` with the arguments as the person typed them.
 */
function awake($: Engine, args: string) {
  return $.command.run({ command: 'awake', args } as CommandRunInput)
}

/**
 * Takes a lease from inside an agent's loop, and says what the tool answered.
 */
async function agentLease($: Engine, agentId: string, minutes: number, reason?: string) {
  const { result } = await $.tool.call({ tool: LEASE_TOOL, minutes, reason, agentId } as never) as { result: string }

  return result
}

const turn = { text: 'hi', turnId: 't1' }
const answered = { turnId: 't1', reason: 'answer' as const, answer: 'done', durationMs: 1000, isAborted: false }
const windows = { OS: 'Windows_NT' }

describe('keep-awake', () => {
  test('holds the machine awake for a turn and a grace time after it', async ($, on) => {
    const engine = fakeEngine(on, windows)

    await $.turn.start(turn)
    await engine.clock.settle()

    expect(engine.spawned).toEqual([HOLDER_ARGV])
    expect(engine.running()).toBe(1)
    expect(engine.status()).toBe(AWAKE_STATUS)

    await $.turn.complete(answered)
    await engine.clock.settle()

    expect(engine.running()).toBe(1)
    expect(engine.status()).toBe(`${AWAKE_STATUS} (5m grace)`)

    await engine.clock.advance(GRACE_MS + 30_000)

    expect(engine.running()).toBe(0)
    expect(engine.status()).toBeUndefined()
  })

  test('holds the Windows host awake from WSL', async ($, on) => {
    const engine = fakeEngine(on, { WSL_DISTRO_NAME: 'Ubuntu' })

    await $.turn.start(turn)
    await engine.clock.settle()

    expect(engine.running()).toBe(1)
  })

  test('does nothing on other systems', async ($, on) => {
    const engine = fakeEngine(on, {})

    await $.turn.start(turn)
    await engine.clock.settle()

    expect(engine.spawned).toEqual([])
    expect(engine.statuses).toEqual([])
  })

  test('keeps one holder across turns that overlap', async ($, on) => {
    const engine = fakeEngine(on, windows)

    await $.turn.start(turn)
    await $.turn.start({ ...turn, turnId: 't2' })
    await engine.clock.settle()

    expect(engine.spawned.length).toBe(1)
  })

  test("a subagent's turn ending does not start the grace time", async ($, on) => {
    const engine = fakeEngine(on, windows)

    await $.turn.start(turn)
    await $.turn.complete({ ...answered, agentId: 'agent-1' })
    await engine.clock.advance(GRACE_MS + 30_000)

    expect(engine.running()).toBe(1)
    expect(engine.status()).toBe(AWAKE_STATUS)
  })

  test("Claude's lease outlives the turn and tells Claude when it ends", LONG, async ($, on) => {
    const engine = fakeEngine(on, windows)

    await $.turn.start(turn)
    const { result } = await $.tool.call({ tool: LEASE_TOOL, minutes: 30, reason: 'build' } as never) as { result: string }
    await $.turn.complete(answered)
    await engine.clock.settle()

    expect(result).toContain('30 minutes')
    expect(engine.status()).toBe(`${AWAKE_STATUS} (Claude: build, 30m left)`)

    await engine.clock.advance(29 * MINUTE)

    expect(engine.prompts).toEqual([])
    expect(engine.running()).toBe(1)

    await engine.clock.advance(MINUTE)

    expect(engine.prompts).toEqual([CLAUDE_CHECK_IN_TEXT])
    expect(engine.running()).toBe(1)
  })

  test('holds until the check-in reaches Claude, then the grace time runs from its turn', LONG, async ($, on) => {
    const engine = fakeEngine(on, windows)

    await $.tool.call({ tool: LEASE_TOOL, minutes: 10 } as never)
    await engine.clock.advance(10 * MINUTE)

    expect(engine.prompts).toEqual([CLAUDE_CHECK_IN_TEXT])

    // The message waits in the queue: nothing has reached Claude yet.
    await engine.clock.advance(CHECK_IN_WAIT_MS - 2 * MINUTE)

    expect(engine.running()).toBe(1)
    expect(engine.status()).toBe(`${AWAKE_STATUS} (lease ended, telling Claude)`)

    await $.turn.start({ text: CLAUDE_CHECK_IN_TEXT, turnId: 't1' })
    await $.turn.complete(answered)
    await engine.clock.advance(GRACE_MS - MINUTE)

    expect(engine.running()).toBe(1)

    await engine.clock.advance(2 * MINUTE)

    expect(engine.running()).toBe(0)
    expect(engine.prompts.length).toBe(1)
  })

  test('sends the check-in again when its turn dies on an error, up to 3 times', LONG, async ($, on) => {
    const engine = fakeEngine(on, windows)
    const failedCheckIn = async () => {
      await $.turn.start({ text: CLAUDE_CHECK_IN_TEXT, turnId: 't1' })
      await $.turn.complete({ ...answered, reason: 'error' })
    }

    await $.tool.call({ tool: LEASE_TOOL, minutes: 1 } as never)
    await engine.clock.advance(MINUTE)
    await failedCheckIn()
    await engine.clock.advance(GRACE_MS)

    expect(engine.prompts.length).toBe(2)
    expect(engine.running()).toBe(1)

    await failedCheckIn()
    await engine.clock.advance(GRACE_MS)

    expect(engine.prompts.length).toBe(3)

    await failedCheckIn()
    await engine.clock.advance(GRACE_MS + MINUTE)

    expect(engine.prompts.length).toBe(3)
    expect(engine.running()).toBe(0)
  })

  for (const submit of ['refuse', 'drop'] as const) {
    test(`a check-in that cannot be sent (${submit}) falls back to the grace time`, LONG, async ($, on) => {
      const engine = fakeEngine(on, windows, submit)

      await $.tool.call({ tool: LEASE_TOOL, minutes: 1 } as never)
      await engine.clock.advance(MINUTE)

      expect(engine.status()).toContain('grace')

      await engine.clock.advance(GRACE_MS)

      expect(engine.running()).toBe(0)
    })
  }

  test('a check-in that never reaches Claude stops holding after a while', LONG, async ($, on) => {
    const engine = fakeEngine(on, windows)

    await $.tool.call({ tool: LEASE_TOOL, minutes: 1 } as never)
    await engine.clock.advance(MINUTE + CHECK_IN_WAIT_MS - 2 * MINUTE)

    expect(engine.running()).toBe(1)

    await engine.clock.advance(2 * MINUTE)

    expect(engine.running()).toBe(0)
  })

  test('/awake off drops a check-in that has not reached Claude', async ($, on) => {
    const engine = fakeEngine(on, windows)

    await $.tool.call({ tool: LEASE_TOOL, minutes: 1 } as never)
    await engine.clock.advance(MINUTE)

    expect(engine.status()).toBe(`${AWAKE_STATUS} (lease ended, telling Claude)`)

    await awake($, 'off')
    await engine.clock.advance(5000)

    expect(engine.running()).toBe(0)
  })

  test('the leases carry on through /clear', async ($, on) => {
    const engine = fakeEngine(on, windows)
    on('session.end', () => ({ sessionId: 's1' }))

    await awake($, 'on')
    await $.session.end({ reason: 'clear' } as never)
    await engine.clock.advance(5000)

    expect(engine.running()).toBe(1)
    expect(engine.status()).toBe(`${AWAKE_STATUS} (you, until /awake off)`)
  })

  test('the leases come back after a reload of the mod', async ($, on) => {
    const engine = fakeEngine(on, windows)
    on('state.get', () => ({ value: { value: { person: {}, graceUntil: 0 }, version: 1 } }))

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await engine.clock.settle()

    expect(engine.running()).toBe(1)
    expect(engine.status()).toBe(`${AWAKE_STATUS} (you, until /awake off)`)
  })

  test("a question in the main turn does not stop a background agent's hold", async ($, on) => {
    const engine = fakeEngine(on, windows)
    on('tool.check', () => ({ decision: 'ask' as const }))
    on('classic.PermissionRequest', async () => {
      await engine.clock.sleep(PERMISSION_WAIT_MS + 5 * MINUTE)

      return { decision: { behavior: 'allow' as const } }
    })
    on('tool.call', () => ({ result: {} }))

    await $.turn.start(turn)
    await $.turn.start({ text: 'work', turnId: 'a1', agentId: 'agent-1' })
    void $.tool.call({ tool: 'Bash', command: 'ls' })
    await engine.clock.advance(PERMISSION_WAIT_MS + MINUTE)

    expect(engine.running()).toBe(1)
    expect(engine.status()).toBe(`${AWAKE_STATUS} (agent working)`)
  })

  test("a background subagent holds the machine until its turn ends", async ($, on) => {
    const engine = fakeEngine(on, windows)

    await $.turn.start(turn)
    await $.turn.start({ text: 'work', turnId: 'a1', agentId: 'agent-1' })
    await $.turn.complete(answered)
    await engine.clock.advance(GRACE_MS + MINUTE)

    expect(engine.running()).toBe(1)

    await $.turn.complete({ ...answered, turnId: 'a1', agentId: 'agent-1' })
    await engine.clock.advance(5000)

    expect(engine.running()).toBe(0)
  })

  test('renewing the lease replaces its end', LONG, async ($, on) => {
    const engine = fakeEngine(on, windows)

    await $.tool.call({ tool: LEASE_TOOL, minutes: 10 } as never)
    await engine.clock.advance(9 * MINUTE)
    await $.tool.call({ tool: LEASE_TOOL, minutes: 10 } as never)
    await engine.clock.advance(9 * MINUTE)

    expect(engine.running()).toBe(1)
    expect(engine.prompts).toEqual([])
  })

  test('a lease of 0 minutes lets the machine sleep', async ($, on) => {
    const engine = fakeEngine(on, windows)

    await $.tool.call({ tool: LEASE_TOOL, minutes: 60 } as never)
    await engine.clock.settle()

    expect(engine.running()).toBe(1)

    await $.tool.call({ tool: LEASE_TOOL, minutes: 0 } as never)
    await engine.clock.advance(5000)

    expect(engine.running()).toBe(0)
    expect(engine.status()).toBeUndefined()
  })

  test('/awake on holds until /awake off', LONG, async ($, on) => {
    const engine = fakeEngine(on, windows)

    const { text } = await awake($, 'on')
    await engine.clock.advance(30 * MINUTE)

    expect(text).toBe(`${AWAKE_STATUS} (you, until /awake off)`)
    expect(engine.running()).toBe(1)

    await awake($, 'off')
    await engine.clock.advance(5000)

    expect(engine.running()).toBe(0)
    expect(engine.prompts).toEqual([])
  })

  test('/awake with a time holds for that time and tells Claude when it ends', LONG, async ($, on) => {
    const engine = fakeEngine(on, windows)

    const { text } = await awake($, '1h30m')

    expect(text).toBe(`${AWAKE_STATUS} (you, 1h 30m left)`)

    await awake($, '20m')
    await engine.clock.advance(20 * MINUTE)

    expect(engine.prompts).toEqual([PERSON_CHECK_IN_TEXT])
    expect(engine.running()).toBe(1)

    await $.turn.start({ text: PERSON_CHECK_IN_TEXT, turnId: 't1' })
    await $.turn.complete(answered)
    await engine.clock.advance(GRACE_MS + MINUTE)

    expect(engine.running()).toBe(0)
  })

  test('a turn stuck on a permission question stops holding after a while', async ($, on) => {
    const engine = fakeEngine(on, windows)
    on('tool.check', () => ({ decision: 'ask' as const }))
    // Stands for a person who answers the question late.
    on('classic.PermissionRequest', async () => {
      await engine.clock.sleep(PERMISSION_WAIT_MS + 5 * MINUTE)

      return { decision: { behavior: 'allow' as const } }
    })
    on('tool.call', () => ({ result: {} }))

    await $.turn.start(turn)
    void $.tool.call({ tool: 'Bash', command: 'ls' })
    await engine.clock.advance(PERMISSION_WAIT_MS + MINUTE)

    expect(engine.running()).toBe(0)

    await engine.clock.advance(5 * MINUTE)

    expect(engine.running()).toBe(1)
    expect(engine.status()).toBe(AWAKE_STATUS)
  })

  describe('leases of several agents', () => {
    test("a shorter lease from one agent does not cut another agent's lease", LONG, async ($, on) => {
      const engine = fakeEngine(on, windows)
      engine.agents.set('a', 'running')
      engine.agents.set('b', 'running')

      await agentLease($, 'a', 60, 'build')
      await agentLease($, 'b', 10, 'tests')
      await engine.clock.advance(30 * MINUTE)

      expect(engine.running()).toBe(1)
      expect(engine.status()).toBe(`${AWAKE_STATUS} (Claude: build, 30m left)`)
    })

    test("an agent ending its lease leaves the other leases, and is told about them", async ($, on) => {
      const engine = fakeEngine(on, windows)
      engine.agents.set('a', 'running')
      engine.agents.set('b', 'running')

      await agentLease($, 'a', 60, 'build')
      await agentLease($, 'b', 20, 'tests')
      const result = await agentLease($, 'a', 0)
      await engine.clock.advance(5000)

      expect(result).toContain('1 other lease still holds: tests (20m)')
      expect(engine.running()).toBe(1)
      expect(engine.status()).toBe(`${AWAKE_STATUS} (Claude: tests, 20m left)`)
    })

    test("the main chat ending its lease leaves the agents' leases", async ($, on) => {
      const engine = fakeEngine(on, windows)
      engine.agents.set('a', 'running')

      await agentLease($, 'a', 60, 'build')
      await $.tool.call({ tool: LEASE_TOOL, minutes: 30 } as never)
      await $.tool.call({ tool: LEASE_TOOL, minutes: 0 } as never)
      await engine.clock.advance(5000)

      expect(engine.running()).toBe(1)
    })

    test('a new lease is told about the others, and the status line counts them', async ($, on) => {
      const engine = fakeEngine(on, windows)
      engine.agents.set('a', 'running')
      engine.agents.set('b', 'running')

      await agentLease($, 'a', 60, 'build')
      const result = await agentLease($, 'b', 20, 'tests')

      expect(result).toContain('20 minutes')
      expect(result).toContain('1 other lease still holds: build (')
      expect(engine.status()).toBe(`${AWAKE_STATUS} (2 leases, 1h 0m left)`)
    })

    test('stopping an agent ends its lease, and tells nobody', async ($, on) => {
      const engine = fakeEngine(on, windows)
      engine.agents.set('a', 'running')

      await $.turn.start({ text: 'work', turnId: 'a1', agentId: 'a' })
      await agentLease($, 'a', 60, 'build')
      engine.agents.set('a', 'killed')
      await $.turn.complete({ ...answered, turnId: 'a1', agentId: 'a', reason: 'aborted', isAborted: true })
      await engine.clock.advance(5000)

      expect(engine.running()).toBe(0)
      expect(engine.status()).toBeUndefined()
      expect(engine.sent).toEqual([])
      expect(engine.prompts).toEqual([])
    })

    test('an agent that failed with no turn end loses its lease at the next check', LONG, async ($, on) => {
      const engine = fakeEngine(on, windows)
      engine.agents.set('a', 'running')

      await agentLease($, 'a', 60, 'build')
      engine.agents.set('a', 'failed')
      await engine.clock.advance(MINUTE + 5000)

      expect(engine.running()).toBe(0)
      expect(engine.sent).toEqual([])
    })

    test('an agent the engine no longer lists loses its lease once its turn has ended', async ($, on) => {
      const engine = fakeEngine(on, windows)
      engine.agents.set('a', 'running')

      await $.turn.start({ text: 'work', turnId: 'a1', agentId: 'a' })
      await agentLease($, 'a', 60, 'build')
      engine.agents.delete('a')
      await $.turn.complete({ ...answered, turnId: 'a1', agentId: 'a' })
      await engine.clock.advance(5000)

      expect(engine.running()).toBe(0)
    })

    test('an agent the engine does not list keeps its lease while its turn runs', LONG, async ($, on) => {
      const engine = fakeEngine(on, windows)

      await agentLease($, 'workflow-agent', 60, 'build')
      await engine.clock.advance(10 * MINUTE)

      expect(engine.running()).toBe(1)
      expect(engine.status()).toBe(`${AWAKE_STATUS} (Claude: build, 50m left)`)
    })

    test('an agent waiting on its own background work keeps its lease after its turn', LONG, async ($, on) => {
      const engine = fakeEngine(on, windows)
      engine.agents.set('a', 'running')

      await $.turn.start({ text: 'work', turnId: 'a1', agentId: 'a' })
      await agentLease($, 'a', 60, 'build')
      engine.agents.set('a', 'waiting')
      await $.turn.complete({ ...answered, turnId: 'a1', agentId: 'a' })
      await engine.clock.advance(10 * MINUTE)

      expect(engine.running()).toBe(1)
    })

    test('when the time ends only that agent is told, and the grace time gives it room to renew', LONG, async ($, on) => {
      const engine = fakeEngine(on, windows)
      engine.agents.set('a', 'waiting')

      await agentLease($, 'a', 10, 'build')
      await engine.clock.advance(10 * MINUTE)

      expect(engine.sent).toEqual([{ to: 'a', text: AGENT_CHECK_IN_TEXT }])
      expect(engine.prompts).toEqual([])
      expect(engine.running()).toBe(1)

      await engine.clock.advance(GRACE_MS + MINUTE)

      expect(engine.running()).toBe(0)
      expect(engine.sent.length).toBe(1)
    })

    test('/awake off ends every agent lease', async ($, on) => {
      const engine = fakeEngine(on, windows)
      engine.agents.set('a', 'running')

      await agentLease($, 'a', 60, 'build')
      await awake($, 'off')
      await engine.clock.advance(5000)

      expect(engine.running()).toBe(0)
      expect(engine.sent).toEqual([])
    })
  })

  test('reads the durations a person types', () => {
    expect(parseDuration('90')).toBe(90 * MINUTE)
    expect(parseDuration('45m')).toBe(45 * MINUTE)
    expect(parseDuration('2h')).toBe(120 * MINUTE)
    expect(parseDuration('1h30m')).toBe(90 * MINUTE)
    expect(parseDuration('soon')).toBeUndefined()
    expect(parseDuration('0')).toBeUndefined()
  })
})
