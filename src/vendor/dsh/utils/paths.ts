/**
 * Data-directory paths for the butterpi profile. All preferences and history
 * live under `~/.butterpi` (decoupled from dsh-TUI's `~/.butterpi`, so butterpi
 * and the DSH ecosystem never share on-disk state).
 *
 * The compiled copy (lib/types/utils/paths.js) is also imported by the bin
 * launcher, mirroring the shellQuote precedent.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The user's home directory. `os.homedir()` first; the USERPROFILE/HOME
 * spellings are the last-resort fallback for stripped-down environments.
 * @returns Absolute home path.
 */
export function homeDir(): string {
  return homedir() || process.env.USERPROFILE || process.env.HOME || ''
}

/** Data directory all preferences/history live in (`~/.butterpi`). */
export const DATA_DIR = join(homeDir(), '.butterpi')
