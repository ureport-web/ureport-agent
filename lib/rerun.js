'use strict'

// Runs one rerun job: the repository, the environment and the command.

const fs = require('fs')
const path = require('path')
const { isUsableRepo } = require('./checkout')
const { exec } = require('./exec')
const { sendRerunResult, writeAuditLog } = require('./reporting')
const { checkCommandAllowlist } = require('./security')

/**
 * Run a rerun_job: checkout (no new branch) or local mode, then run command.
 * Reports exit code back as rerun_result.
 */
async function runRerunJob(msg, cfg) {
  const { signal_id, config, test } = msg
  const { command, timeout_minutes, env, repo } = config

  // Parse env overrides
  const envOverrides = {}
  if (env) {
    for (const line of env.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const idx = trimmed.indexOf('=')
      if (idx > 0) envOverrides[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1)
    }
  }

  let workdir

  if (repo.mode === 'checkout') {
    // Checkout mode: fetch + checkout base branch + reset --hard (no new branch)
    const laneKey = command.includes('__') ? command : `${test.uid || 'rerun'}`.replace(/[^a-z0-9]/gi, '-').slice(0, 20)
    workdir = path.join(cfg.repo_path, `rerun__${laneKey.slice(0, 30)}`)
    fs.mkdirSync(cfg.repo_path, { recursive: true })

    const remote = repo.remote
    const baseBranch = repo.base_branch || 'main'

    const repoExists = await isUsableRepo(workdir)
    if (!repoExists) {
      if (!remote) throw new Error('repo.remote is not set in rerun config')
      console.log(`[rerun] cloning ${remote} → ${workdir}`)
      await exec('git', ['clone', remote, workdir], { cwd: cfg.repo_path })
    } else {
      await exec('git', ['reset', '--hard', 'HEAD'], { cwd: workdir }).catch(() => {})
      await exec('git', ['clean', '-fd'], { cwd: workdir }).catch(() => {})
      await exec('git', ['fetch', 'origin'], { cwd: workdir })
    }

    try {
      await exec('git', ['checkout', baseBranch], { cwd: workdir })
    } catch {
      const r = await exec('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: workdir }).catch(() => null)
      const detected = r ? r.stdout.trim().replace('origin/', '') : null
      if (!detected) throw new Error(`Branch '${baseBranch}' not found and could not detect remote default`)
      console.log(`[rerun] base branch '${baseBranch}' not found, using '${detected}'`)
      await exec('git', ['checkout', detected], { cwd: workdir })
    }
    await exec('git', ['reset', '--hard', `origin/${baseBranch}`], { cwd: workdir })

    if (repo.install_command?.trim()) {
      console.log(`[rerun] running install: ${repo.install_command}`)
      await exec('sh', ['-c', repo.install_command], { cwd: workdir, timeout: 5 * 60 * 1000 })
    }
  } else {
    // Local mode: use configured path as-is
    workdir = repo.path
    if (!workdir || !fs.existsSync(workdir)) throw new Error(`Local repo path not found: ${workdir}`)
    console.log(`[rerun] using local path: ${workdir}`)
  }

  // Resolve {test.file}, {test.name}, {test.uid} in command
  const resolvedCommand = command
    .replace(/\{test\.file\}/gi, test.file || '')
    .replace(/\{test\.name\}/gi, test.name || '')
    .replace(/\{test\.uid\}/gi,  test.uid  || '')

  const timeoutMs = (timeout_minutes || 10) * 60 * 1000
  const rerunCheck = checkCommandAllowlist(resolvedCommand, cfg)
  if (!rerunCheck.ok) {
    console.error(`[rerun] BLOCKED — ${rerunCheck.reason}`)
    writeAuditLog(cfg, { event: 'command_blocked', stage: 'rerun', reason: rerunCheck.reason, cmd: resolvedCommand })
    sendRerunResult(signal_id, { status: 'error', output: `Command blocked by allowlist: ${rerunCheck.reason}`, exit_code: -1 })
    return
  }
  console.log(`[rerun] running: ${resolvedCommand}`)

  try {
    const r = await exec('sh', ['-c', resolvedCommand], {
      cwd: workdir,
      timeout: timeoutMs,
      env: { ...process.env, ...envOverrides },
    })
    const output = (r.stdout + r.stderr).trim()
    console.log('[rerun] passed (exit 0)')
    sendRerunResult(signal_id, { status: 'passed', command: resolvedCommand, output, exit_code: 0 })
  } catch (err) {
    const exitCode = err.exitCode != null ? err.exitCode : 1
    const output   = (err.output || err.message || '').trim()
    const status   = exitCode === -1 ? 'timed_out' : 'failed'
    console.log(`[rerun] ${status} (exit ${exitCode})`)
    sendRerunResult(signal_id, { status, command: resolvedCommand, output, exit_code: exitCode })
  }
}

module.exports = { runRerunJob }
