import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function resolveOrcaCli(execPath = process.execPath) {
  const bundled = join(dirname(execPath), '..', 'Resources', 'bin', 'orca')
  return existsSync(bundled) ? bundled : 'orca'
}

export function runOrca(cli, args, timeout = 10_000) {
  return new Promise((resolve, reject) => {
    execFile(cli, args, { timeout, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(error)
      try { resolve(JSON.parse(stdout)) } catch (error) { reject(error) }
    })
  })
}

export async function openBoardTab(cli, path, url, run = runOrca) {
  const worktree = `path:${path}`
  const listed = await run(cli, ['tab', 'list', '--worktree', worktree, '--json'])
  if (!listed.ok) throw new Error(listed.error.message)
  const tab = listed.result.tabs.find((tab) => tab.url.startsWith(url))
  const result = await run(cli, tab
    ? ['tab', 'switch', '--page', tab.browserPageId, '--worktree', worktree, '--focus', '--json']
    : ['tab', 'create', '--url', url, '--worktree', worktree, '--json'])
  if (!result.ok) throw new Error(result.error.message)
}
