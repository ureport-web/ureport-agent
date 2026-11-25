'use strict'

// The checkout stage: clone or update the repository and branch off the base.

const fs = require('fs')
const path = require('path')
const { exec } = require('./exec')
const { jobEnv } = require('./job-env')

/**
 * True when workdir is a working git repo. A leftover folder without a valid
 * .git (interrupted clone, wiped by a previous run) is removed so the caller
 * re-clones instead of failing on `git fetch` with "not a git repository".
 */
async function isUsableRepo(workdir) {
  if (!fs.existsSync(workdir)) return false
  const ok = await exec('git', ['rev-parse', '--git-dir'], { cwd: workdir }).then(() => true, () => false)
  if (ok && fs.existsSync(path.join(workdir, '.git'))) return true
  console.log(`[checkout] ${workdir} is not a usable git repo — removing for a fresh clone`)
  fs.rmSync(workdir, { recursive: true, force: true })
  return false
}

async function stageCheckout(checkout, ctx, cfg, signalId) {
  const { lane } = ctx
  const laneDir = `${lane.product}__${lane.type}`
  const workdir = path.join(cfg.repo_path, laneDir)
  const testSlug = (ctx.test?.name || 'test').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  const shortId = signalId.slice(-8)
  const prefix = checkout.branchPrefix || 'fix/auto-'
  const branch = `${prefix}${testSlug}/${shortId}`

  fs.mkdirSync(cfg.repo_path, { recursive: true })

  const repoExists = await isUsableRepo(workdir)
  if (!repoExists) {
    if (!checkout.remote) throw new Error('checkout.remote is not set in the playbook — configure the repo URL in Auto-Heal settings')
    console.log(`[checkout] cloning ${checkout.remote} → ${workdir}`)
    await exec('git', ['clone', checkout.remote, workdir], { cwd: cfg.repo_path })
    // After fresh clone, already on default branch — resolve actual base branch name
    const headR = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: workdir })
    const actualBase = headR.stdout.trim()
    if (actualBase && actualBase !== checkout.baseBranch) {
      console.log(`[checkout] base branch '${checkout.baseBranch}' not found, using detected default '${actualBase}'`)
      checkout = { ...checkout, baseBranch: actualBase }
    }
  } else {
    // Clean any dirty state from previous runs before switching branches
    await exec('git', ['reset', '--hard', 'HEAD'], { cwd: workdir }).catch(() => {})
    await exec('git', ['clean', '-fd'], { cwd: workdir }).catch(() => {})
    await exec('git', ['fetch', 'origin'], { cwd: workdir })
    // Try configured baseBranch; fall back to remote HEAD if missing
    try {
      await exec('git', ['checkout', checkout.baseBranch], { cwd: workdir })
    } catch {
      const r = await exec('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: workdir }).catch(() => null)
      const detected = r ? r.stdout.trim().replace('origin/', '') : null
      if (!detected) throw new Error(`Branch '${checkout.baseBranch}' not found and could not detect remote default branch`)
      console.log(`[checkout] base branch '${checkout.baseBranch}' not found, using detected default '${detected}'`)
      checkout = { ...checkout, baseBranch: detected }
      await exec('git', ['checkout', checkout.baseBranch], { cwd: workdir })
    }
  }

  await exec('git', ['reset', '--hard', `origin/${checkout.baseBranch}`], { cwd: workdir })
  await exec('git', ['checkout', '-b', branch], { cwd: workdir })

  if (checkout.installCommand?.trim()) {
    console.log(`[checkout] running install: ${checkout.installCommand}`)
    await exec('sh', ['-c', checkout.installCommand], { cwd: workdir, timeout: 5 * 60 * 1000, env: jobEnv() })
  }

  return { workdir, branch, baseBranch: checkout.baseBranch }
}

module.exports = { isUsableRepo, stageCheckout }
