/**
 * The frontend advertises what the transcript can render (notably mermaid
 * diagrams) by appending a note to the model's system prompt. These cases pin
 * that the note is actually present, that a user's `--append-system-prompt`
 * survives alongside it, and that `--no-harness-notes` turns it off.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { BUTTERPI_HARNESS_NOTES, butterpiAppendSystemPrompt } from '../src/harness-notes.js'

test('the harness note advertises mermaid rendering', () => {
  assert.match(BUTTERPI_HARNESS_NOTES, /mermaid/)
  assert.match(BUTTERPI_HARNESS_NOTES, /```mermaid/)
})

test('the harness note is injected on its own by default', () => {
  assert.deepEqual(butterpiAppendSystemPrompt({}), [BUTTERPI_HARNESS_NOTES])
})

test('a user append prompt stays and the harness note follows it', () => {
  assert.deepEqual(butterpiAppendSystemPrompt({ appendSystemPrompt: 'MY RULES' }), [
    'MY RULES',
    BUTTERPI_HARNESS_NOTES,
  ])
})

test('--no-harness-notes keeps only the user append prompt', () => {
  assert.deepEqual(
    butterpiAppendSystemPrompt({ appendSystemPrompt: 'MY RULES', noHarnessNotes: true }),
    ['MY RULES'],
  )
  assert.equal(butterpiAppendSystemPrompt({ noHarnessNotes: true }), undefined)
})
