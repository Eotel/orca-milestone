// Sends a pressed next step to its agent through orca-board's `send`, which records the message on
// the board (ORCA_BRIEFS_BIN, ~/.cache/orca-briefs/bin by default). Typing the prompt with
// `orca terminal send` would reach the agent without the board knowing.
import { execFile } from 'node:child_process'
import { dirname, isAbsolute, join } from 'node:path'

const SEND_TIMEOUT_MS = 60_000
// send's exit codes: 0 the text landed, 3 it landed but the agent answered with its usage limit.
const LANDED = new Set([0, 3])
// The person who pressed sees a failure on the card and may press again, so send keeps no copy to
// deliver later, which would arrive twice.
const NO_KEEP = '--no-keep'

/**
 * @param home  the user's home, also the folder send runs in: send records the folder's name as who sent it
 * @param cli   the Orca CLI the worker uses, put first on the PATH so that send reaches the same Orca
 * @returns a function that sends a prompt to a terminal handle and resolves to send's report, or
 *   throws with send's FAILED line
 */
export function createLaneSender({ home, cli = 'orca', env = process.env, run = execFile }) {
  const command = join(env.ORCA_BRIEFS_BIN ?? join(home, '.cache', 'orca-briefs', 'bin'), 'send')
  const path = [isAbsolute(cli) ? dirname(cli) : null, env.PATH].filter(Boolean).join(':')
  return (handle, prompt) =>
    new Promise((resolve, reject) => {
      run(command, [NO_KEEP, handle, prompt], { cwd: home, env: { ...env, PATH: path }, timeout: SEND_TIMEOUT_MS }, (error, stdout, stderr) => {
        const report = `${stdout}`.trim()
        if (!error || LANDED.has(error.code)) resolve(report)
        else reject(new Error(report || `${stderr}`.trim() || error.message))
      })
    })
}
