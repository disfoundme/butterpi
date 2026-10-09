/**
 * `resumeTo` is the single entry point the resume screen uses to mount a
 * session, including one from another workspace. These cases pin its contract:
 * a normal switch, pi's missing-cwd fallback (the project was moved or deleted),
 * a cancelled switch, and hard failures.
 *
 * The channel is built from its prototype so the test does not need a real
 * session store, terminal or runtime: `resumeTo` only touches the runtime's
 * `switchSession`, the session-path cache, the bound session's cwd and `notify`.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PiChannel } from '../src/pi-channel.js'

interface SwitchCall {
  path: string
  cwdOverride: string | undefined
}

interface SwitchOutcome {
  cancelled: boolean
}

interface Harness {
  channel: PiChannel
  calls: SwitchCall[]
  notifications: { text: string; color: string | undefined }[]
}

function harness(options: {
  currentCwd: string
  sessionPath: string
  switchSession: (path: string, cwdOverride: string | undefined) => Promise<SwitchOutcome>
}): Harness {
  const calls: SwitchCall[] = []
  const notifications: { text: string; color: string | undefined }[] = []
  const channel = Object.create(PiChannel.prototype) as PiChannel
  Object.assign(channel as unknown as Record<string, unknown>, {
    runtime: {
      switchSession: (path: string, opts?: { cwdOverride?: string }) => {
        const cwdOverride = opts?.cwdOverride
        calls.push({ path, cwdOverride })
        return options.switchSession(path, cwdOverride)
      },
    },
    sessionPathCache: new Map<string, string>([['session-1', options.sessionPath]]),
    _session: {
      sessionId: 'current',
      sessionFile: undefined,
      sessionManager: { getCwd: () => options.currentCwd },
    },
    notify: (text: string, opts?: { color?: string }) => {
      notifications.push({ text, color: opts?.color })
      return () => {}
    },
  })
  return { channel, calls, notifications }
}

function makeSessionFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'butterpi-resume-test-'))
  const path = join(dir, 'session.jsonl')
  writeFileSync(path, '{"type":"session"}\n')
  return path
}

function missingCwdError(sessionCwd: string): Error {
  const error = new Error(`Stored session working directory does not exist: ${sessionCwd}`)
  error.name = 'MissingSessionCwdError'
  ;(error as Error & { issue?: { sessionCwd: string } }).issue = { sessionCwd }
  return error
}

test('resumeTo switches into the resolved session path', async () => {
  const sessionPath = makeSessionFile()
  const { channel, calls, notifications } = harness({
    currentCwd: '/work/here',
    sessionPath,
    switchSession: async () => ({ cancelled: false }),
  })

  assert.deepEqual(await channel.resumeTo('session-1'), { ok: true })
  assert.deepEqual(calls, [{ path: sessionPath, cwdOverride: undefined }])
  assert.equal(notifications.length, 0)
})

test('resumeTo re-homes a session whose recorded cwd is gone', async () => {
  const sessionPath = makeSessionFile()
  const { channel, calls, notifications } = harness({
    currentCwd: '/work/here',
    sessionPath,
    switchSession: async (_path, cwdOverride) => {
      if (cwdOverride === undefined) throw missingCwdError('/old/gone')
      return { cancelled: false }
    },
  })

  assert.deepEqual(await channel.resumeTo('session-1'), { ok: true })
  assert.deepEqual(calls, [
    { path: sessionPath, cwdOverride: undefined },
    { path: sessionPath, cwdOverride: '/work/here' },
  ])
  assert.equal(notifications.length, 1)
  assert.match(notifications[0]!.text, /原目录不存在/)
  assert.match(notifications[0]!.text, /\/old\/gone/)
  assert.equal(notifications[0]!.color, 'warning')
})

test('resumeTo reports a cancelled switch instead of success', async () => {
  const sessionPath = makeSessionFile()
  const { channel } = harness({
    currentCwd: '/work/here',
    sessionPath,
    switchSession: async () => ({ cancelled: true }),
  })

  assert.deepEqual(await channel.resumeTo('session-1'), { ok: false, reason: 'cancelled' })
})

test('resumeTo reports an unexpected switch failure', async () => {
  const sessionPath = makeSessionFile()
  const { channel } = harness({
    currentCwd: '/work/here',
    sessionPath,
    switchSession: async () => {
      throw new Error('boom')
    },
  })

  assert.deepEqual(await channel.resumeTo('session-1'), { ok: false, reason: 'failed', error: 'boom' })
})

test('resumeTo surfaces a failed re-home without warning', async () => {
  const sessionPath = makeSessionFile()
  const { channel, notifications } = harness({
    currentCwd: '/work/here',
    sessionPath,
    switchSession: async (_path, cwdOverride) => {
      if (cwdOverride === undefined) throw missingCwdError('/old/gone')
      throw new Error('still broken')
    },
  })

  assert.deepEqual(await channel.resumeTo('session-1'), { ok: false, reason: 'failed', error: 'still broken' })
  // The warning means "opened in the current directory", so it must not fire
  // when the fallback also failed.
  assert.equal(notifications.length, 0)
})
