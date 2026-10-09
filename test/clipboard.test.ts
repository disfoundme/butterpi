/**
 * Mouse selection copies through `setClipboard`. On Windows the local safety
 * net used to pipe UTF-8 to `clip.exe`, which decodes piped bytes with the
 * console code page — non-ASCII selections came back as mojibake. The fix
 * hands PowerShell a UTF-8 file and decodes it explicitly. These cases pin the
 * command shape without needing Windows.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { windowsClipboardCommand } from '../src/vendor/dsh/ink/termio/osc.js'

test('the Windows clipboard command decodes a UTF-8 file explicitly', () => {
  const { file, args } = windowsClipboardCommand('C:\\Users\\me\\butterpi-clip-x.txt')
  assert.equal(file, 'powershell.exe')
  assert.ok(args.includes('-NoProfile'))
  const script = args[args.length - 1]!
  assert.match(script, /Set-Clipboard/)
  // The whole point: an explicit UTF-8 decode, never the console code page.
  assert.match(script, /\[System\.Text\.Encoding\]::UTF8/)
  assert.ok(script.includes('C:\\Users\\me\\butterpi-clip-x.txt'))
  // No stdin pipe: piped bytes are what clip/PowerShell mis-decode.
  assert.doesNotMatch(script, /\|/)
})

test('the Windows clipboard command escapes apostrophes in the path', () => {
  const { args } = windowsClipboardCommand("C:\\Temp\\it's here.txt")
  assert.ok(args[args.length - 1]!.includes("'C:\\Temp\\it''s here.txt'"))
})
