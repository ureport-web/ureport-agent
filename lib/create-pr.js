'use strict'

// The create PR stage: commit, push and open the pull request on the git host.

const { resolveRemote, createPullRequest } = require('../git-providers')
const { applyTestVars } = require('./ai-fix')
const { exec } = require('./exec')

async function stageCreatePr(createPr, checkout, resolvedBaseBranch, ctx, cfg, signalId, workdir, diffSummary, options = {}) {
  const apiToken = createPr.apiToken
  if (!apiToken) throw new Error('API token not set — add it to the playbook Create PR settings')

  // Resolve the git host first so an unsupported remote fails before anything is pushed
  let remoteUrl = checkout?.remote
  if (!remoteUrl) {
    try {
      const r = await exec('git', ['remote', 'get-url', 'origin'], { cwd: workdir })
      remoteUrl = r.stdout.trim()
    } catch { /* no origin remote; reported below */ }
  }
  if (!remoteUrl) {
    throw new Error('No git remote found. Set the repo URL in the playbook\'s Checkout settings.')
  }
  const target = resolveRemote(remoteUrl, cfg.git_hosts)

  // Commit if there are changes
  const statusR = await exec('git', ['status', '--porcelain'], { cwd: workdir })
  if ((statusR.stdout || '').trim()) {
    await exec('git', ['add', '-A'], { cwd: workdir })
    await exec('git', ['commit', '-m', `fix: auto-heal for ${ctx.test.name} [signal: ${signalId}]`], { cwd: workdir })
  }

  const branchR = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: workdir })
  const branch = branchR.stdout.trim()

  // Nothing to propose: the branch has no commit beyond its base, so the host would answer
  // "no changes" (Bitbucket 400). Happens when the AI finds nothing to fix. Skip the push.
  const baseForCompare = resolvedBaseBranch || createPr.baseBranch
  if (baseForCompare) {
    try {
      const ahead = await exec('git', ['rev-list', '--count', `origin/${baseForCompare}..HEAD`], { cwd: workdir })
      if (parseInt(ahead.stdout.trim(), 10) === 0) {
        const noChanges = new Error('No code changes to propose: the branch is identical to the base branch')
        noChanges.noChanges = true
        throw noChanges
      }
    } catch (err) {
      if (err.noChanges) throw err
      // base ref not available locally: skip the check and let the push/PR report any problem
    }
  }

  const shaR = await exec('git', ['rev-parse', 'HEAD'], { cwd: workdir })
  const commitSha = shaR.stdout.trim()

  await exec('git', ['push', 'origin', branch], { cwd: workdir })

  const prBody = buildPrBody(ctx, diffSummary, signalId, { ureportUrl: cfg.ureport_url, ...options })
  const prBase = resolvedBaseBranch || createPr.baseBranch
  const rawTitle = createPr.titleTemplate || `fix: auto-heal for {test.name}`
  const prTitle = applyTestVars(rawTitle, ctx.test, null)
  const prUrl = await createPullRequest(target, {
    token: apiToken,
    username: createPr.apiUsername,
    title: prTitle,
    body: prBody,
    head: branch,
    base: prBase,
  })
  console.log(`[create-pr] PR created: ${prUrl}`)
  return { prUrl, branch, commitSha }
}

function buildPrBody(ctx, diffSummary, signalId, options = {}) {
  const { analysis, ureportUrl, wip, testOutput } = options
  const lines = []

  if (wip) {
    lines.push('> ⚠️ **Work in Progress** — the test is still failing after this fix. Review and iterate before merging.', '')
  }

  lines.push('## Auto-Heal Fix', '')
  lines.push(`**Test:** ${ctx.test.name}`)
  if (ctx.test.file) lines.push(`**File:** \`${ctx.test.file}\``)
  lines.push(`**Signal:** \`${signalId}\``)
  lines.push(`**Triggered by:** ${ctx.triggered_by || 'ureport'}`)
  if (ureportUrl && ctx.launches_path) {
    lines.push(`**UReport:** [View in launches](${ureportUrl}${ctx.launches_path})`)
  }
  lines.push('')

  if (analysis) {
    lines.push('## AI Analysis', '')
    lines.push(analysis)
    lines.push('')
  }

  if (diffSummary) lines.push(`## Changes`, '', diffSummary, '')

  if (ctx.test.error_message) {
    lines.push('## Original Error', '', '```', ctx.test.error_message.slice(0, 1000), '```', '')
  }

  if (wip && testOutput) {
    lines.push('## Test Output (still failing)', '', '```', testOutput.slice(0, 2000), '```', '')
  }

  lines.push('---', '*Created by [ureport-agent](https://github.com/your-org/ureport)*')
  return lines.join('\n')
}

module.exports = { stageCreatePr }
