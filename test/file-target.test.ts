/**
 * 74308a90: an automatic file link must start at a text boundary. Without
 * this, `/idle/needs-input` inside `working/idle/needs-input` was linkified
 * as if it were an absolute path (#1181).
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { linkifyFilePaths } from '../src/vendor/dsh/utils/fileTarget.js'

const wrap = (path: string): string => `[[${path}]]`

test('a slash-anchored fragment welded into a word is not linked', () => {
  assert.equal(linkifyFilePaths('working/idle/needs-input', wrap), 'working/idle/needs-input')
})

test('a standalone path at a text boundary is linked', () => {
  assert.equal(linkifyFilePaths('see /abs/path.ts here', wrap), 'see [[/abs/path.ts]] here')
})

test('a URL interior stays excluded', () => {
  assert.equal(linkifyFilePaths('https://example.com/x.ts', wrap), 'https://example.com/x.ts')
})
