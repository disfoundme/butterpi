/**
 * Markdown/math fixes ported from dsh-TUI. These cover the behaviours the
 * upstream fix commits changed, at the ANSI-output level (what the user
 * actually sees), so a regression in the port fails here.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import stripAnsi from 'strip-ansi'
import { applyMarkdown } from '../src/vendor/dsh/terminal-utils/markdown.js'

test('CJK-adjacent strong emphasis closes (52f4f50b)', () => {
  const out = stripAnsi(applyMarkdown('**证据与影响：**源码中回落'))
  assert.equal(out.includes('**'), false)
  assert.match(out, /证据与影响：源码中回落/)
})

test('ASCII strong without a boundary stays literal, like GitHub (52f4f50b)', () => {
  const out = stripAnsi(applyMarkdown('**note:**see'))
  assert.match(out, /\*\*note:\*\*see/)
})

test('task-list items render their checkbox state (da40d3b8)', () => {
  const out = stripAnsi(applyMarkdown('- [x] done\n- [ ] todo\n'))
  assert.match(out, /\[x\] done/)
  assert.match(out, /\[ \] todo/)
})

test('a synchronously throwing highlighter degrades to plaintext (702cb95f)', () => {
  const highlight = {
    supportsLanguage: (): boolean => true,
    highlight: (): string => {
      throw new Error('boom')
    },
  }
  const out = stripAnsi(applyMarkdown('```js\nconst x = 1\n```', highlight as never))
  assert.match(out, /const x = 1/)
})

test('a block opener inside a cross-line code span does not cut the paragraph (f1468e96)', () => {
  // The $$ sits inside an open backtick span, so it is code, not a formula.
  const out = stripAnsi(applyMarkdown('`code\n$$\nmore`\n'))
  assert.match(out, /\$\$/)
})
