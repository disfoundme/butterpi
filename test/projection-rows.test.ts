/**
 * Live transcript projection must keep each row's id stable while a message
 * streams. The id is the React key, so regenerating it remounts the row on
 * every delta — which resets the thinking spinner and the streaming-markdown
 * anchors and reads as transcript flicker (worst on Windows Terminal).
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { PiChannel } from '../src/pi-channel.js'

interface FakeChannel {
  groupStart: number
  groupRowIds: string[]
  groupStreaming: boolean
  groupOpenedAt: number
  rowList: Array<{ id: number; kind: string; text: string; streaming?: boolean }>
  rowSeq: number
  toolRows: Map<string, unknown>
}

function fakeChannel(): FakeChannel {
  return {
    groupStart: -1,
    groupRowIds: [],
    groupStreaming: false,
    groupOpenedAt: 0,
    rowList: [],
    rowSeq: 1,
    toolRows: new Map(),
  }
}

function project(ch: FakeChannel, content: unknown[], streaming: boolean): void {
  const message = { role: 'assistant', content, timestamp: 0 }
  ;(PiChannel.prototype as unknown as {
    projectAssistantBlocks: (m: unknown, ctx: unknown, activeIndex?: number) => void
  }).projectAssistantBlocks.call(ch, message, { live: true, streaming })
}

test('a streaming reasoning row keeps its id across deltas', () => {
  const ch = fakeChannel()
  project(ch, [{ type: 'thinking', thinking: 'reason 1' }], true)
  const firstId = ch.rowList[0]!.id
  assert.equal(ch.rowList[0]!.kind, 'reasoning')
  assert.equal(ch.rowList[0]!.streaming, true)

  project(ch, [{ type: 'thinking', thinking: 'reason 1 more' }], true)
  assert.equal(ch.rowList.length, 1)
  assert.equal(ch.rowList[0]!.id, firstId, 'the reasoning row must not be remounted per delta')
  assert.equal(ch.rowList[0]!.text, 'reason 1 more')
})

test('a streaming text row keeps its id across deltas', () => {
  const ch = fakeChannel()
  project(ch, [{ type: 'text', text: 'hello' }], true)
  const firstId = ch.rowList[0]!.id
  project(ch, [{ type: 'text', text: 'hello world' }], true)
  assert.equal(ch.rowList[0]!.id, firstId, 'the assistant row must not be remounted per delta')
})

test('settling keeps the id and clears streaming', () => {
  const ch = fakeChannel()
  project(ch, [{ type: 'thinking', thinking: 'reason' }], true)
  const firstId = ch.rowList[0]!.id
  project(ch, [{ type: 'thinking', thinking: 'reason' }], false)
  assert.equal(ch.rowList[0]!.id, firstId)
  assert.equal(ch.rowList[0]!.streaming, false)
})
