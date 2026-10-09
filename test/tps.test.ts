/**
 * The live "tps" number used to be a character rate labelled tok/s (≈4× too
 * high) and could spike into the thousands when its window had just drained.
 * These cases pin the converted units and the refusal to report a window with
 * no real interval.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { CHARS_PER_TOKEN, estimateTps, TPS_MIN_SPAN_MS } from '../src/tps.js'

test('tps is tokens per second, not characters per second', () => {
  // 400 chars over 1000ms = 400 chars/s = 100 tokens/s at 4 chars/token.
  assert.equal(CHARS_PER_TOKEN, 4)
  assert.equal(estimateTps([{ t: 0, chars: 400 }], 1000), 100)
})

test('tps sums the window and divides by its span', () => {
  // 200 chars over 1000ms = 200 chars/s -> 50 tok/s.
  assert.equal(estimateTps([{ t: 0, chars: 100 }, { t: 1000, chars: 100 }], 1000), 50)
})

test('tps refuses a window with no real interval instead of spiking', () => {
  assert.equal(estimateTps([], 5000), undefined)
  // One sample: span 0. The old code clamped the span to 1ms and returned
  // chars * 1000 / 4 instead of a real rate.
  assert.equal(estimateTps([{ t: 5000, chars: 50 }], 5000), undefined)
  assert.equal(estimateTps([{ t: 5000, chars: 50 }], 5000 + TPS_MIN_SPAN_MS - 1), undefined)
})

test('tps reports once the window spans the minimum', () => {
  assert.equal(estimateTps([{ t: 0, chars: 40 }], TPS_MIN_SPAN_MS), 40)
})
