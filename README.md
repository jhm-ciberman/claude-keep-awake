# keep-awake

A Claude Code mod that stops Windows from going to sleep while Claude works. The screen still turns off on its normal timer. Only sleep is blocked.

The PC stays awake:

- **During a turn**: while Claude or one of its subagents is working.
- **For 5 minutes after a turn**: a grace time, so a short gap does not put the PC to sleep.
- **While Claude holds a lease**: for background work that outlives the turn, up to 4 hours at a time.
- **When you ask**: with `/awake`.

The status line shows `☕ awake` and the reason.

A turn stuck for 15 minutes on a permission question stops counting as work, so a question nobody answers does not keep the PC awake.

## Install

From a shell:

```
claude plugin marketplace add jhm-ciberman/claude-keep-awake
claude plugin install keep-awake@keep-awake
```

Then run `/reload-plugins` in any open session.

## Usage

```
/awake on       Stay awake until /awake off
/awake 2h       Stay awake for a time: 90, 45m, 2h or 1h30m
/awake off      End your time and every lease Claude holds
/awake          Show why the PC is awake
```

## How it works

Claude gets a `keep_awake` tool. It takes a number of minutes and an optional reason. Minutes 0 ends the lease.

Each agent has its own lease:

- A new lease replaces only the caller's own time. The tool's answer lists the other leases.
- When an agent's run ends, crashes or is stopped, its lease goes away with it.
- An agent that is still alive when its time ends gets a message, so it can renew. The main conversation gets its own message the same way.

One small PowerShell process holds the request to Windows. It writes to Claude Code every 5 seconds. When Claude Code is gone, the write fails and the process exits, so a closed terminal never leaves the PC held awake.

## Requirements

Windows, or WSL on Windows. On other systems the mod does nothing.

## Development

```
claude plugin validate .
claude plugin test .
```
