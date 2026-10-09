/**
 * The resume screen builds its workspace rail from two sources that arrive at
 * different times: cwd-derived fallback rows appear with the session listing,
 * and the durable registry rows arrive with the ledger. A directory can be
 * rendered as an `unregistered` row and then as a `registry` row — the same
 * directory under two different ids.
 *
 * These cases pin the derivations that decide which row's sessions the pane
 * shows, without a terminal: a regression here is exactly "the workspace I
 * picked shows no sessions" or "the pick is lost when the ledger lands".
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  resolveSelectedRailEntry,
  samePath,
  UNREGISTERED_RAIL_ID,
} from '../src/vendor/dsh/screens/sessionSupervisor/model.js'
import type { RailEntry } from '../src/vendor/dsh/screens/sessionSupervisor/model.js'

function entry(id: string, path: string, from: RailEntry['from']): RailEntry {
  return { id, path, title: path, present: true, sessionCount: 0, from }
}

const butterpi = entry('r:butterpi', '/work/butterpi', 'registry')
const piA = entry(`${UNREGISTERED_RAIL_ID}:/tmp/piA`, '/tmp/piA', 'unregistered')
const piB = entry(`${UNREGISTERED_RAIL_ID}:/tmp/piB`, '/tmp/piB', 'unregistered')

test('samePath compares cwd keys without treating ancestors as equal', () => {
  assert.equal(samePath('/tmp/piA', '/tmp/piA/'), true)
  assert.equal(samePath('/tmp/piA', '/tmp/piB'), false)
  assert.equal(samePath('/tmp/piA', '/tmp/piA/sub'), false)
})

test('resolveSelectedRailEntry picks the row with the selected path', () => {
  const rows = [butterpi, piA, piB]
  assert.equal(resolveSelectedRailEntry(rows, '/tmp/piB')?.id, piB.id)
  assert.equal(resolveSelectedRailEntry(rows, '/tmp/piA')?.id, piA.id)
  assert.equal(resolveSelectedRailEntry(rows, '/work/butterpi')?.id, butterpi.id)
})

test('resolveSelectedRailEntry keeps the pick when a fallback row becomes a registry row', () => {
  // Before the ledger lands the directory only exists as a fallback row...
  const beforeLoad = [piA]
  assert.equal(resolveSelectedRailEntry(beforeLoad, '/tmp/piA')?.from, 'unregistered')

  // ...and after it lands the SAME path is a registry row with a different id.
  // Matching by id would lose the pick here; matching by path must not.
  const afterLoad = [entry('r:piA', '/tmp/piA', 'registry'), piA]
  const kept = resolveSelectedRailEntry(afterLoad, '/tmp/piA')
  assert.equal(kept?.from, 'registry')
  assert.equal(kept?.path, '/tmp/piA')
})

test('resolveSelectedRailEntry falls back to the first row without a match', () => {
  const rows = [butterpi, piA]
  assert.equal(resolveSelectedRailEntry(rows, undefined)?.id, butterpi.id)
  assert.equal(resolveSelectedRailEntry(rows, '/nope')?.id, butterpi.id)
})

test('resolveSelectedRailEntry returns undefined for an empty rail', () => {
  assert.equal(resolveSelectedRailEntry([], '/tmp/piA'), undefined)
})
