/**
 * Dragging a text selection is a high-frequency mouse-motion stream. It used
 * to call notifySelectionChange()/renderNow() on every event, repainting the
 * whole screen synchronously per motion — the drag felt slow (worse on
 * Windows Terminal, whose output is expensive). It must coalesce through the
 * frame throttle instead, while still notifying selection listeners.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import Ink from '../src/vendor/dsh/ink/ink.js'
import { createSelectionState, startSelection } from '../src/vendor/dsh/ink/selection.js'

test('a selection drag coalesces its paint through the frame throttle', () => {
  const events: string[] = []
  let notified = 0
  const fake = {
    altScreenActive: true,
    selection: createSelectionState(),
    frontFrame: { screen: undefined },
    scheduleRender: () => { events.push('scheduleRender') },
    renderNow: () => { events.push('renderNow') },
    selectionListeners: new Set<() => void>([() => { notified++ }]),
  }
  startSelection(fake.selection, 0, 0)

  Ink.prototype.handleSelectionDrag.call(fake as never, 3, 1)

  assert.deepEqual(events, ['scheduleRender'])
  assert.equal(notified, 1)
})
