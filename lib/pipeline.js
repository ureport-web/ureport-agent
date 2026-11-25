'use strict'

// Runs one heal job: the guided pipeline of checkout, AI fix and create PR.

const { buildCliFixPrompt, stageAiFix } = require('./ai-fix')
const { stageCheckout } = require('./checkout')
const { stageCreatePr } = require('./create-pr')
const { exec } = require('./exec')
const { beginJobEnv } = require('./job-env')
const { sendProgress, sendResult, writeAuditLog } = require('./reporting')

async function handleTestFailed(signalId, pipeline, resolvedBaseBranch, ctx, cfg, wd, { testOutput, attemptedDiff, agentAnalysis, stepsCompleted, stepOutputs }) {
  if (pipeline.createPr?.enabled && pipeline.createPr?.createOnTestFailed) {
    console.log('[test_failed] createOnTestFailed is set — creating WIP PR')
    sendProgress(signalId, 2, 'createPr', 'running', 'Creating WIP pull request (test still failing)...', null)
    try {
      const wipCreatePr = { ...pipeline.createPr, titleTemplate: `[WIP] ${pipeline.createPr.titleTemplate || 'fix: auto-heal {test.name}'}` }
      const out = await stageCreatePr(wipCreatePr, pipeline.checkout, resolvedBaseBranch, ctx, cfg, signalId, wd, attemptedDiff, { analysis: agentAnalysis, wip: true, testOutput })
      stepOutputs.createPr = out
      stepsCompleted++
      sendProgress(signalId, 2, 'createPr', 'done', `WIP PR created: ${out.prUrl}`, out)
      return sendResult(signalId, { status: 'test_failed', pr_url: out.prUrl, branch: out.branch, test_output: testOutput, attempted_diff: attemptedDiff, agent_analysis: agentAnalysis, steps_completed: stepsCompleted, step_outputs: stepOutputs })
    } catch (err) {
      console.warn('[test_failed] WIP PR creation failed:', err.message)
      sendProgress(signalId, 2, 'createPr', 'failed', `WIP PR failed: ${err.message}`, null)
    }
  }
  return sendResult(signalId, { status: 'test_failed', test_output: testOutput, attempted_diff: attemptedDiff, agent_analysis: agentAnalysis, steps_completed: stepsCompleted, step_outputs: stepOutputs })
}

async function runGuidedPipeline(signalId, playbook, ctx, cfg) {
  const pipeline = playbook.pipeline
  const stepOutputs = {}
  let stepsCompleted = 0
  let workdir = null
  let resolvedBaseBranch = null
  let diffSummary = null
  let attemptedDiff = null
  let agentAnalysis = null
  // Flaky self-heal evidence: the test passed on this agent's own run (the CLI verified it) and
  // the AI changed no files. Only then is `completed` reported with rerun_passed.
  let testVerifiedPassed = false
  let filesChangedTotal = 0
  const completedOutcome = (extra) => ({
    status: 'completed',
    ...(testVerifiedPassed && filesChangedTotal === 0 ? { rerun_passed: true, completion_reason: 'flaky' } : {}),
    ...extra,
  })
  let testOutput = null
  // The pull request the AI opened inside its own session, when the playbook asks it to
  let aiPr = null

  // Stage 0: Checkout
  if (pipeline.checkout?.enabled) {
    sendProgress(signalId, 0, 'checkout', 'running', 'Checking out repository...', null)
    try {
      const out = await stageCheckout(pipeline.checkout, ctx, cfg, signalId)
      workdir = out.workdir
      resolvedBaseBranch = out.baseBranch
      stepOutputs.checkout = out
      stepsCompleted++
      sendProgress(signalId, 0, 'checkout', 'done', `Branch ready: ${out.branch}`, out)
    } catch (err) {
      sendProgress(signalId, 0, 'checkout', 'failed', err.message, null)
      return sendResult(signalId, { status: 'error', error_detail: `checkout: ${err.message}`, steps_completed: stepsCompleted, step_outputs: stepOutputs })
    }
  }

  // With checkout off the AI works in repo_path as it is
  const wd = workdir || cfg.repo_path

  // Stage 1: AI Fix (with retry for CLI provider self-verification)
  if (pipeline.aiFix?.enabled) {
    const isCliProv = pipeline.aiFix.provider === 'claude-cli' || pipeline.aiFix.provider === 'gemini-cli'
    const maxAttempts = (isCliProv && pipeline.aiFix.maxAttempts > 1)
      ? Math.min(pipeline.aiFix.maxAttempts, 5)
      : 1
    let previousAttempt = null
    let aiFixOut = null
    const allAttempts = []

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const attemptLabel = maxAttempts > 1 ? ` (attempt ${attempt}/${maxAttempts})` : ''
      const cliPromptForLog = isCliProv
        ? buildCliFixPrompt(pipeline.aiFix, ctx, wd, previousAttempt)
        : null
      sendProgress(signalId, 1, 'aiFix', 'running', `Asking AI to generate a fix${attemptLabel}...`, null)
      try {
        aiFixOut = await stageAiFix(pipeline.aiFix, ctx, cfg, wd, { previousAttempt })
        allAttempts.push({
          attempt,
          analysis:     aiFixOut.analysis,
          filesChanged: aiFixOut.filesChanged,
          appliedFiles: aiFixOut.appliedFiles,
          diff:         aiFixOut.diff,
          testPassed:   aiFixOut.testPassed,
          testOutput:   aiFixOut.testOutput,
        })
        agentAnalysis = aiFixOut.analysis
        testOutput = aiFixOut.testOutput || null
        filesChangedTotal = aiFixOut.filesChanged || 0
        // Only a run whose test passed counts: an attempt that opened a PR and then failed is not the result
        // A link only found in the AI's text is trusted when the Create PR stage is off; with it on, that stage opens the PR
        const trusted = aiFixOut.prUrl && (!aiFixOut.prUrlFromText || !pipeline.createPr?.enabled)
        aiPr = trusted && aiFixOut.testPassed !== false ? { prUrl: aiFixOut.prUrl, branch: aiFixOut.prBranch } : null
        if (isCliProv && aiFixOut.testPassed === true) testVerifiedPassed = true
        attemptedDiff = aiFixOut.diff
        diffSummary   = aiFixOut.diffSummary
        stepOutputs.aiFix = { ...aiFixOut, attempts: allAttempts }
        stepsCompleted++

        // CLI providers self-report test result
        if (isCliProv && aiFixOut.testPassed === false) {
          if (attempt < maxAttempts) {
            console.log(`[ai-fix] attempt ${attempt} failed — resetting files and retrying`)
            sendProgress(signalId, 1, 'aiFix', 'running', `Test still failing after attempt ${attempt} — resetting and retrying...`, { ...aiFixOut, attempts: allAttempts })
            // Reset files written by this attempt so next session starts from original code
            if (aiFixOut.appliedFiles && aiFixOut.appliedFiles.length > 0) {
              try {
                await exec('git', ['checkout', 'HEAD', '--', ...aiFixOut.appliedFiles], { cwd: wd })
                console.log(`[ai-fix] reset ${aiFixOut.appliedFiles.length} file(s) for retry`)
              } catch (resetErr) {
                console.warn('[ai-fix] file reset failed (continuing anyway):', resetErr.message)
              }
            }
            previousAttempt = { analysis: aiFixOut.analysis, testOutput: aiFixOut.testOutput }
            stepsCompleted-- // don't count failed attempts
            continue
          }
          console.log(`[ai-fix] all ${maxAttempts} attempt(s) failed — stopping pipeline`)
          sendProgress(signalId, 1, 'aiFix', 'failed', `Test still failing after ${maxAttempts} attempt(s)`, { ...aiFixOut, attempts: allAttempts })
          return handleTestFailed(signalId, pipeline, resolvedBaseBranch, ctx, cfg, wd, { testOutput: aiFixOut.testOutput, attemptedDiff, agentAnalysis, stepsCompleted, stepOutputs })
        }

        const verifyNote = aiFixOut.testPassed === true ? ' — test passed ✓' : ''
        sendProgress(signalId, 1, 'aiFix', 'done', `Applied ${aiFixOut.filesChanged} file change(s)${verifyNote}`, { ...aiFixOut, attempts: allAttempts })
        break
      } catch (err) {
        const errOutput = cliPromptForLog ? { inputPrompt: { prompt: cliPromptForLog } } : null
        sendProgress(signalId, 1, 'aiFix', 'failed', err.message, errOutput)
        return sendResult(signalId, { status: 'error', error_detail: `ai_fix: ${err.message}`, steps_completed: stepsCompleted, step_outputs: stepOutputs, agent_analysis: agentAnalysis })
      }
    }
  }

  // The AI opened the pull request itself: report it, whatever the Create PR stage says (a second PR would be a duplicate)
  if (aiPr) {
    console.log(`[ai-fix] the AI opened a pull request: ${aiPr.prUrl}`)
    sendProgress(signalId, 2, 'createPr', 'done', `PR created by the AI: ${aiPr.prUrl}`, { prUrl: aiPr.prUrl, branch: aiPr.branch, byAi: true })
    return sendResult(signalId, { status: 'pr_created', pr_url: aiPr.prUrl, ...(aiPr.branch ? { branch: aiPr.branch } : {}), diff_summary: diffSummary, test_output: testOutput, attempted_diff: attemptedDiff, agent_analysis: agentAnalysis, steps_completed: stepsCompleted + 1, step_outputs: stepOutputs })
  }

  // Stage 2: Create PR
  if (pipeline.createPr?.enabled) {
    sendProgress(signalId, 2, 'createPr', 'running', 'Creating pull request...', null)
    try {
      const out = await stageCreatePr(pipeline.createPr, pipeline.checkout, resolvedBaseBranch, ctx, cfg, signalId, wd, diffSummary, { analysis: agentAnalysis })
      stepOutputs.createPr = out
      stepsCompleted++
      sendProgress(signalId, 2, 'createPr', 'done', `PR created: ${out.prUrl}`, out)
      return sendResult(signalId, { status: 'pr_created', pr_url: out.prUrl, branch: out.branch, diff_summary: diffSummary, test_output: testOutput, steps_completed: stepsCompleted, step_outputs: stepOutputs })
    } catch (err) {
      if (err.noChanges) {
        sendProgress(signalId, 2, 'createPr', 'skipped', `Skipped — ${err.message}`, { skipped: true, reason: err.message })
        return sendResult(signalId, completedOutcome({ diff_summary: diffSummary, test_output: testOutput, attempted_diff: attemptedDiff, agent_analysis: agentAnalysis, steps_completed: stepsCompleted, step_outputs: stepOutputs }))
      }
      sendProgress(signalId, 2, 'createPr', 'failed', err.message, null)
      return sendResult(signalId, { status: 'error', error_detail: `create_pr: ${err.message}`, steps_completed: stepsCompleted, step_outputs: stepOutputs, attempted_diff: attemptedDiff, agent_analysis: agentAnalysis })
    }
  }

  // All enabled stages done, no createPr
  sendResult(signalId, completedOutcome({ diff_summary: diffSummary, test_output: testOutput, attempted_diff: attemptedDiff, agent_analysis: agentAnalysis, steps_completed: stepsCompleted, step_outputs: stepOutputs }))
}

async function runJob(msg, cfg) {
  const { signal_id, playbook, job_context } = msg
  const missingEnv = beginJobEnv(cfg, playbook)
  if (missingEnv.length) {
    const detail = `Missing environment variable(s) on the agent: ${missingEnv.join(', ')}. Export them in the shell that starts the agent, or add them to the env_file in ureport-agent.yml.`
    console.error(`[agent] ${detail}`)
    writeAuditLog(cfg, { event: 'env_missing', type: 'heal_job', signal_id, missing: missingEnv })
    return sendResult(signal_id, { status: 'error', error_detail: detail, steps_completed: 0, step_outputs: {} })
  }
  await runGuidedPipeline(signal_id, playbook, job_context, cfg)
}

module.exports = { runJob }
