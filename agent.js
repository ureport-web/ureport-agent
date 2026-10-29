#!/usr/bin/env node
'use strict'

const fs      = require('fs')
const path    = require('path')
const yaml    = require('js-yaml')
const WebSocket = require('ws')
const { spawn } = require('child_process')
const crypto = require('crypto')

const VERSION = require('./package.json').version

// ── Security helpers ───────────────────────────────────────────────────────

/**
 * Write an entry to the audit log if configured.
 * Each line is a JSON object: { ts, ...fields }
 */
function writeAuditLog(cfg, fields) {
  if (!cfg.audit_log) return
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...fields }) + '\n'
    fs.appendFileSync(cfg.audit_log, line)
  } catch (e) {
    console.warn('[agent] audit log write failed:', e.message)
  }
}

/**
 * Verify HMAC-SHA256 signature on an incoming job message.
 * Returns true if: signing_secret not configured, or signature matches.
 * Returns false if: signing_secret configured but sig missing or wrong.
 */
function verifyPayloadSig(msg, signingSecret) {
  if (!signingSecret) return true
  const { sig, ...payload } = msg
  if (!sig) return false
  const expected = crypto.createHmac('sha256', signingSecret)
    .update(JSON.stringify(payload))
    .digest('hex')
  try {
    return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))
  } catch {
    return false
  }
}

/**
 * Check a shell command against the security allowlist.
 * Always blocks backtick and $( command substitution.
 * If allowed_run_prefixes configured, command must start with one of them.
 * Returns { ok: true } or { ok: false, reason: string }.
 */
const COMMAND_INJECTION_RE = /`|\$\(|\x00/
function checkCommandAllowlist(cmd, cfg) {
  if (COMMAND_INJECTION_RE.test(cmd)) {
    return { ok: false, reason: `command injection pattern in: ${cmd}` }
  }
  if (cfg.allowed_run_prefixes && cfg.allowed_run_prefixes.length > 0) {
    const allowed = cfg.allowed_run_prefixes.some(prefix => cmd.startsWith(prefix))
    if (!allowed) {
      return { ok: false, reason: `command does not match any allowed prefix. Got: ${cmd}` }
    }
  }
  return { ok: true }
}


// ── Config ─────────────────────────────────────────────────────────────────

function loadConfig() {
  const configPath = process.argv[2] || path.resolve(process.cwd(), 'ureport-agent.yml')
  if (!fs.existsSync(configPath)) {
    console.error(`[agent] config not found: ${configPath}`)
    console.error('[agent] copy ureport-agent.yml.example to ureport-agent.yml and fill in your values')
    process.exit(1)
  }
  const raw = yaml.load(fs.readFileSync(configPath, 'utf8'))
  if (!raw.ureport_url || !raw.agent_token) {
    console.error('[agent] ureport_url and agent_token are required in config')
    process.exit(1)
  }
  if (raw.agent_token === 'PASTE_YOUR_TOKEN_HERE') {
    console.error('[agent] replace PASTE_YOUR_TOKEN_HERE with a real token from /auto-heal')
    process.exit(1)
  }
  return {
    ureport_url:                raw.ureport_url.trim().replace(/\/+$/, ''),
    agent_token:                raw.agent_token.trim(),
    repo_path:                  raw.repo_path ? path.resolve(raw.repo_path.trim()) : path.resolve(process.cwd(), 'workspace'),
    ai_model:                   raw.ai_model || 'claude-sonnet-4-6',
    claude_cli_timeout_minutes:  raw.claude_cli_timeout_minutes  ? Number(raw.claude_cli_timeout_minutes)  : null,
    gemini_cli_timeout_minutes:  raw.gemini_cli_timeout_minutes  ? Number(raw.gemini_cli_timeout_minutes)  : null,
    signing_secret:       raw.signing_secret       ? String(raw.signing_secret).trim()                : null,
    allowed_run_prefixes: Array.isArray(raw.allowed_run_prefixes)
      ? raw.allowed_run_prefixes.map(p => String(p).trim()).filter(Boolean)
      : (raw.allowed_run_prefixes ? [String(raw.allowed_run_prefixes).trim()] : []),
    accept_job_types: Array.isArray(raw.accept_job_types)
      ? raw.accept_job_types
      : ['heal', 'rerun'],
    audit_log: raw.audit_log ? path.resolve(String(raw.audit_log).trim()) : null,
  }
}

// ── WebSocket connection ───────────────────────────────────────────────────

let _cfg = null  // set at startup; used by audit log helpers
let _ws = null
let _reconnectTimer = null
let _stopping = false
let _currentJob = null  // signal_id of running job; null if idle

const RECONNECT_DELAY_MS   = 5_000
const HEARTBEAT_INTERVAL_MS = 30_000

function wsUrl(cfg) {
  return cfg.ureport_url.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://') + '/ws/agent'
}

function send(msg) {
  if (_ws && _ws.readyState === WebSocket.OPEN) {
    _ws.send(JSON.stringify(msg))
  }
}

function connect(cfg) {
  if (_stopping) return
  const url = wsUrl(cfg)
  console.log(`[agent] connecting to ${url}`)

  _ws = new WebSocket(url, { headers: { Authorization: `Bearer ${cfg.agent_token}` } })

  _ws.on('open', () => {
    console.log('[agent] connected')
    _currentJob = null  // reset — any mid-flight job from previous connection is orphaned

    send({ type: 'hello', version: VERSION, active_lanes: [], job_types: cfg.accept_job_types })

    const hb = setInterval(() => {
      if (_ws && _ws.readyState === WebSocket.OPEN) _ws.ping()
      else clearInterval(hb)
    }, HEARTBEAT_INTERVAL_MS)
    _ws._hbTimer = hb
  })

  _ws.on('message', (data) => {
    let msg
    try { msg = JSON.parse(data.toString()) }
    catch { console.warn('[agent] unparseable message'); return }

    handleMessage(msg, cfg)
  })

  _ws.on('pong', () => { /* heartbeat ack */ })

  _ws.on('close', (code, reason) => {
    console.warn(`[agent] disconnected (code=${code} reason=${reason || 'none'})`)
    if (_ws._hbTimer) clearInterval(_ws._hbTimer)
    scheduleReconnect(cfg)
  })

  _ws.on('error', (err) => {
    console.error('[agent] WS error:', err.message)
  })
}

function scheduleReconnect(cfg) {
  if (_stopping || _reconnectTimer) return
  console.log(`[agent] reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`)
  _reconnectTimer = setTimeout(() => { _reconnectTimer = null; connect(cfg) }, RECONNECT_DELAY_MS)
}

// ── Message handler ────────────────────────────────────────────────────────

function handleMessage(msg, cfg) {
  switch (msg.type) {
    case 'registered':
      console.log(`[agent] registered as: ${msg.agent_name}`)
      break

    case 'heal_job': {
      if (!verifyPayloadSig(msg, cfg.signing_secret)) {
        console.error(`[agent] heal_job REJECTED — invalid signature for signal=${msg.signal_id}`)
        writeAuditLog(cfg, { event: 'job_rejected', reason: 'invalid_signature', signal_id: msg.signal_id })
        return
      }
      if (!cfg.accept_job_types.includes('heal')) {
        console.warn(`[agent] heal_job ignored — 'heal' not in accept_job_types`)
        writeAuditLog(cfg, { event: 'job_rejected', reason: 'job_type_not_accepted', signal_id: msg.signal_id })
        return
      }
      writeAuditLog(cfg, { event: 'job_received', type: 'heal_job', signal_id: msg.signal_id, mode: msg.playbook?.mode })
      if (_currentJob) {
        console.warn(`[agent] already running job ${_currentJob} — ignoring new job ${msg.signal_id}`)
        return
      }
      _currentJob = msg.signal_id
      console.log(`[agent] job received: signal=${msg.signal_id} mode=${msg.playbook?.mode}`)
      runJob(msg, cfg).catch(err => {
        console.error('[agent] unhandled job error:', err.message)
        sendResult(msg.signal_id, { status: 'error', error_detail: err.message, steps_completed: 0, step_outputs: {} })
      })
      break
    }

    case 'rerun_job': {
      if (!verifyPayloadSig(msg, cfg.signing_secret)) {
        console.error(`[agent] rerun_job REJECTED — invalid signature for signal=${msg.signal_id}`)
        writeAuditLog(cfg, { event: 'job_rejected', reason: 'invalid_signature', signal_id: msg.signal_id })
        return
      }
      if (!cfg.accept_job_types.includes('rerun')) {
        console.warn(`[agent] rerun_job ignored — 'rerun' not in accept_job_types`)
        writeAuditLog(cfg, { event: 'job_rejected', reason: 'job_type_not_accepted', signal_id: msg.signal_id })
        return
      }
      writeAuditLog(cfg, { event: 'job_received', type: 'rerun_job', signal_id: msg.signal_id })
      if (_currentJob) {
        console.warn(`[agent] already running job ${_currentJob} — ignoring rerun job ${msg.signal_id}`)
        return
      }
      _currentJob = msg.signal_id
      console.log(`[agent] rerun job received: signal=${msg.signal_id}`)
      send({ type: 'rerun_running', signal_id: msg.signal_id })
      runRerunJob(msg, cfg).catch(err => {
        console.error('[agent] unhandled rerun job error:', err.message)
        sendRerunResult(msg.signal_id, { status: 'error', output: err.message, exit_code: -1 })
      })
      break
    }

    case 'ping':
      send({ type: 'pong' })
      break

    default:
      // ignore unknown (registered, pong, etc.)
  }
}

// ── Progress / Result helpers ──────────────────────────────────────────────

function sendProgress(signalId, stepIndex, stepId, status, message, output) {
  send({ type: 'progress', signal_id: signalId, step_index: stepIndex, step_id: stepId, status, message, output: output || null })
}

function sendResult(signalId, outcome) {
  send({ type: 'result', signal_id: signalId, ...outcome })
  writeAuditLog(_cfg, { event: 'job_result', type: 'heal_job', signal_id: signalId, status: outcome.status })
  _currentJob = null
}

function sendRerunResult(signalId, outcome) {
  send({ type: 'rerun_result', signal_id: signalId, ...outcome })
  writeAuditLog(_cfg, { event: 'job_result', type: 'rerun_job', signal_id: signalId, status: outcome.status })
  _currentJob = null
}

// ── Job dispatcher ─────────────────────────────────────────────────────────

async function runJob(msg, cfg) {
  const { signal_id, playbook, job_context } = msg
  if (playbook.mode === 'guided') {
    await runGuidedPipeline(signal_id, playbook, job_context, cfg)
  } else if (playbook.mode === 'agent_delegation') {
    await runAgentDelegation(signal_id, playbook, job_context, cfg)
  } else {
    sendResult(signal_id, { status: 'error', error_detail: `unknown mode: ${playbook.mode}`, steps_completed: 0, step_outputs: {} })
  }
}

// ── Guided Pipeline helpers ────────────────────────────────────────────────

async function handleTestFailed(signalId, pipeline, resolvedBaseBranch, ctx, cfg, wd, { testOutput, attemptedDiff, agentAnalysis, stepsCompleted, stepOutputs }) {
  if (pipeline.createPr?.enabled && pipeline.createPr?.createOnTestFailed) {
    console.log('[test_failed] createOnTestFailed is set — creating WIP PR')
    sendProgress(signalId, 3, 'createPr', 'running', 'Creating WIP pull request (test still failing)...', null)
    try {
      const wipCreatePr = { ...pipeline.createPr, titleTemplate: `[WIP] ${pipeline.createPr.titleTemplate || 'fix: auto-heal {test.name}'}` }
      const out = await stageCreatePr(wipCreatePr, pipeline.checkout, resolvedBaseBranch, ctx, cfg, signalId, wd, attemptedDiff, { analysis: agentAnalysis, wip: true, testOutput })
      stepOutputs.createPr = out
      stepsCompleted++
      sendProgress(signalId, 3, 'createPr', 'done', `WIP PR created: ${out.prUrl}`, out)
      return sendResult(signalId, { status: 'test_failed', pr_url: out.prUrl, branch: out.branch, test_output: testOutput, attempted_diff: attemptedDiff, agent_analysis: agentAnalysis, steps_completed: stepsCompleted, step_outputs: stepOutputs })
    } catch (err) {
      console.warn('[test_failed] WIP PR creation failed:', err.message)
      sendProgress(signalId, 3, 'createPr', 'failed', `WIP PR failed: ${err.message}`, null)
    }
  }
  return sendResult(signalId, { status: 'test_failed', test_output: testOutput, attempted_diff: attemptedDiff, agent_analysis: agentAnalysis, steps_completed: stepsCompleted, step_outputs: stepOutputs })
}

// ── Guided Pipeline ────────────────────────────────────────────────────────

async function runGuidedPipeline(signalId, playbook, ctx, cfg) {
  const pipeline = playbook.pipeline
  const stepOutputs = {}
  let stepsCompleted = 0
  let workdir = null
  let resolvedBaseBranch = null
  let diffSummary = null
  let attemptedDiff = null
  let agentAnalysis = null
  let testOutput = null

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

  // Stage 2: Verify
  if (pipeline.verify?.enabled) {
    const isCliProvForVerify = pipeline.aiFix?.provider === 'claude-cli' || pipeline.aiFix?.provider === 'gemini-cli'
    if (pipeline.aiFix?.enabled && isCliProvForVerify) {
      console.log('[verify] skipped — CLI provider self-verifies during the AI fix step')
      const skippedOut = { skipped: true, reason: 'CLI provider self-verifies during the AI fix step' }
      stepOutputs.verify = skippedOut
      sendProgress(signalId, 2, 'verify', 'skipped', 'Skipped — CLI provider runs and verifies the test during the AI fix step', skippedOut)
      stepsCompleted++
    } else {
      const rawCmd = (pipeline.verify.command || '').trim() || 'npm test'
      sendProgress(signalId, 2, 'verify', 'running', `Running: ${rawCmd}`, null)
      try {
        const out = await stageVerify(pipeline.verify, ctx, cfg, wd)
        testOutput = out.output
        stepOutputs.verify = out
        stepsCompleted++
        if (!out.passed) {
          sendProgress(signalId, 2, 'verify', 'failed', 'Tests still failing after fix', out)
          return handleTestFailed(signalId, pipeline, resolvedBaseBranch, ctx, cfg, wd, { testOutput, attemptedDiff, agentAnalysis, stepsCompleted, stepOutputs })
        }
        sendProgress(signalId, 2, 'verify', 'done', 'Tests passed', out)
      } catch (err) {
        sendProgress(signalId, 2, 'verify', 'failed', err.message, null)
        return sendResult(signalId, { status: 'error', error_detail: `verify: ${err.message}`, steps_completed: stepsCompleted, step_outputs: stepOutputs, attempted_diff: attemptedDiff, agent_analysis: agentAnalysis })
      }
    }
  }

  // Stage 3: Create PR
  if (pipeline.createPr?.enabled) {
    sendProgress(signalId, 3, 'createPr', 'running', 'Creating pull request...', null)
    try {
      const out = await stageCreatePr(pipeline.createPr, pipeline.checkout, resolvedBaseBranch, ctx, cfg, signalId, wd, diffSummary, { analysis: agentAnalysis })
      stepOutputs.createPr = out
      stepsCompleted++
      sendProgress(signalId, 3, 'createPr', 'done', `PR created: ${out.prUrl}`, out)
      return sendResult(signalId, { status: 'pr_created', pr_url: out.prUrl, branch: out.branch, diff_summary: diffSummary, test_output: testOutput, steps_completed: stepsCompleted, step_outputs: stepOutputs })
    } catch (err) {
      sendProgress(signalId, 3, 'createPr', 'failed', err.message, null)
      return sendResult(signalId, { status: 'error', error_detail: `create_pr: ${err.message}`, steps_completed: stepsCompleted, step_outputs: stepOutputs, attempted_diff: attemptedDiff, agent_analysis: agentAnalysis })
    }
  }

  // All enabled stages done, no createPr
  sendResult(signalId, { status: 'completed', diff_summary: diffSummary, test_output: testOutput, attempted_diff: attemptedDiff, agent_analysis: agentAnalysis, steps_completed: stepsCompleted, step_outputs: stepOutputs })
}

// ── Stage: Checkout ────────────────────────────────────────────────────────

async function stageCheckout(checkout, ctx, cfg, signalId) {
  const { lane } = ctx
  const laneDir = `${lane.product}__${lane.type}`
  const workdir = path.join(cfg.repo_path, laneDir)
  const testSlug = (ctx.test?.name || 'test').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  const shortId = signalId.slice(-8)
  const prefix = checkout.branchPrefix || 'fix/auto-'
  const branch = `${prefix}${testSlug}/${shortId}`

  fs.mkdirSync(cfg.repo_path, { recursive: true })

  const repoExists = fs.existsSync(path.join(workdir, '.git'))
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
    await exec('sh', ['-c', checkout.installCommand], { cwd: workdir, timeout: 5 * 60 * 1000 })
  }

  return { workdir, branch, baseBranch: checkout.baseBranch }
}

// ── Stage: AI Fix ──────────────────────────────────────────────────────────

/**
 * Resolves a test file path (possibly an absolute CI path like
 * /opt/atlassian/pipelines/agent/build/src/...) to a file that exists
 * inside workdir. Returns { resolved, relative } or null.
 */
function resolveTestFile(workdir, testFilePath) {
  if (!testFilePath) return null
  // Try direct join (works for relative paths)
  const direct = path.join(workdir, testFilePath)
  if (fs.existsSync(direct)) {
    return { resolved: direct, relative: testFilePath }
  }
  // For absolute paths: progressively strip leading path segments
  const parts = testFilePath.replace(/\\/g, '/').split('/').filter(Boolean)
  for (let i = 1; i < parts.length; i++) {
    const suffix = parts.slice(i).join('/')
    const candidate = path.join(workdir, suffix)
    if (fs.existsSync(candidate)) {
      return { resolved: candidate, relative: suffix }
    }
  }
  return null
}

/**
 * Apply remaining agent-side variable substitution.
 * The plugin resolves all data vars before sending the job — the only thing
 * the agent uniquely knows is the repo-relative file path from the checkout.
 * This function substitutes {test.file} with the resolved relativeFile and
 * leaves everything else as a safety fallback for basic fields.
 */
function applyTestVars(str, test, relativeFile) {
  if (!str) return str
  return str
    .replace(/\{test\.file\}/gi, relativeFile || test.file || '')
    .replace(/\{test\.name\}/gi, test.name || '')
    .replace(/\{test\.uid\}/gi,  test.uid  || '')
}

function buildAiFixPrompts(aiFix, ctx, workdir) {
  const { test, lane } = ctx
  let testFileContent = ''
  let resolvedRelative = test.file || null
  if (test.file) {
    const r = resolveTestFile(workdir, test.file)
    if (r) {
      resolvedRelative = r.relative
      try { testFileContent = fs.readFileSync(r.resolved, 'utf8') } catch {}
    }
  }
  const systemPrompt = aiFix.apiFixSystemPrompt || aiFix.instructions || ''
  let stepsSection = null
  if (test.steps && test.steps.length > 0) {
    const lines = [`## Steps Around Failure (${test.steps[0].index}–${test.steps[test.steps.length - 1].index} of ${test.steps[0].total})`]
    test.steps.forEach(s => lines.push(`  [${s.status}] ${s.detail}`))
    stepsSection = lines.join('\n')
  }

  const userContent = [
    `Product: ${lane.product}  Type: ${lane.type}`,
    `Test: ${test.name}`,
    resolvedRelative ? `File: ${resolvedRelative}` : null,
    '',
    '## Error',
    test.error_message || '(none)',
    test.stack_trace ? `\n## Stack Trace\n${test.stack_trace}` : null,
    stepsSection,
    testFileContent ? `\n## Current File (${resolvedRelative})\n\`\`\`\n${testFileContent}\n\`\`\`` : null,
  ].filter(Boolean).join('\n')
  return { systemPrompt, userContent }
}

/**
 * Builds a prompt for Claude CLI agent mode.
 * Claude CLI has native file tools, so we don't embed file content —
 * we tell it the repo is in the current directory and let it explore.
 */
function buildCliFixPrompt(aiFix, ctx, workdir, previousAttempt = null) {
  const { test, lane } = ctx
  const r = resolveTestFile(workdir, test.file)
  const relativeFile = r ? r.relative : test.file

  // All prompt blocks are pre-built by the plugin; agent only injects runtime context
  // Apply relativeFile substitution to blocks that contain {test.file}/{test.name} placeholders
  const applyFileVars = (s) => s
    ? s.replace(/\{test\.file\}/gi, relativeFile || test.file || '').replace(/\{test\.name\}/gi, test.name || '')
    : s

  const runHintBlock  = applyFileVars(aiFix.runHintBlock)
  const stepsBlock    = applyFileVars(aiFix.stepsBlock)
  const outputBlock   = aiFix.outputFormatBlock || ''

  const lines = []
  if (aiFix.instructions) { lines.push(aiFix.instructions); lines.push('') }
  if (runHintBlock) { lines.push(runHintBlock) }

  if (previousAttempt) {
    lines.push(aiFix.previousAttemptHeader)
    if (previousAttempt.analysis)   { lines.push(aiFix.previousAttemptAnalysis); lines.push(previousAttempt.analysis) }
    if (previousAttempt.testOutput) { lines.push(aiFix.previousAttemptOutput);   lines.push(previousAttempt.testOutput) }
    lines.push('')
  }

  lines.push('The repository is checked out in the current directory. Use your file tools to explore it.')
  lines.push('')
  lines.push(`Product: ${lane.product}  Type: ${lane.type}`)
  lines.push(`Test: ${test.name}`)
  if (relativeFile) lines.push(`File: ${relativeFile}`)
  lines.push('')
  lines.push('## Error')
  lines.push(test.error_message || '(none)')
  if (test.stack_trace) { lines.push(''); lines.push('## Stack Trace'); lines.push(test.stack_trace) }
  if (test.steps && test.steps.length > 0) {
    lines.push(`\n## Steps Around Failure (${test.steps[0].index}–${test.steps[test.steps.length - 1].index} of ${test.steps[0].total})`)
    test.steps.forEach(s => lines.push(`  [${s.status}] ${s.detail}`))
  }
  lines.push('')
  if (stepsBlock)  lines.push(stepsBlock)
  if (outputBlock) lines.push(outputBlock)
  return lines.join('\n')
}

function parseAiJsonResponse(rawText, providerName) {
  // Strip markdown fences
  let cleaned = rawText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
  // If text precedes the JSON object, extract the first {...} block
  const jsonStart = cleaned.indexOf('{')
  if (jsonStart > 0) cleaned = cleaned.slice(jsonStart)
  // Trim trailing content after the last }
  const jsonEnd = cleaned.lastIndexOf('}')
  if (jsonEnd !== -1 && jsonEnd < cleaned.length - 1) cleaned = cleaned.slice(0, jsonEnd + 1)
  try {
    return JSON.parse(cleaned)
  } catch (err) {
    throw new Error(`${providerName} returned invalid JSON: ${err.message} — raw: ${rawText.slice(0, 300)}`)
  }
}

async function callAiFix(aiFix, ctx, cfg, workdir, options = {}) {
  const provider = aiFix.provider || 'claude-cli'
  const { systemPrompt, userContent } = buildAiFixPrompts(aiFix, ctx, workdir)
  let parsed
  let rawResponse = ''

  if (provider === 'claude-cli') {
    console.log('[ai-fix] calling Claude CLI (agent mode, cwd:', workdir, ')...')
    const cliPrompt = buildCliFixPrompt(aiFix, ctx, workdir, options.previousAttempt || null)
    const cliTimeout = (cfg.claude_cli_timeout_minutes || 30) * 60 * 1000
    const r = await exec('claude', ['--print', '--output-format', 'json', cliPrompt], { timeout: cliTimeout, cwd: workdir })
    const rawOutput = (r.stdout || '').trim()
    rawResponse = rawOutput
    try {
      const envelope = JSON.parse(rawOutput)
      rawResponse = envelope.result || rawOutput
    } catch {}
    parsed = parseAiJsonResponse(rawResponse, 'Claude CLI')
  } else if (provider === 'gemini-cli') {
    console.log('[ai-fix] calling Gemini CLI (agent mode, cwd:', workdir, ')...')
    const cliPrompt = buildCliFixPrompt(aiFix, ctx, workdir, options.previousAttempt || null)
    const cliTimeout = (cfg.gemini_cli_timeout_minutes || 30) * 60 * 1000
    const modelArgs = aiFix.model ? ['--model', aiFix.model] : []
    const r = await exec('gemini', ['-p', cliPrompt, '--yolo', ...modelArgs], { timeout: cliTimeout, cwd: workdir })
    rawResponse = (r.stdout || '').trim()
    parsed = parseAiJsonResponse(rawResponse, 'Gemini CLI')
  } else {
    throw new Error(`Unknown AI provider: ${provider}. Supported: claude-cli, gemini-cli`)
  }

  return { parsed, rawResponse, systemPrompt, userContent }
}

async function stageAiFix(aiFix, ctx, cfg, workdir, options = {}) {
  const { parsed, rawResponse, systemPrompt, userContent } = await callAiFix(aiFix, ctx, cfg, workdir, options)
  const analysis    = parsed.analysis || ''
  const changes     = Array.isArray(parsed.changes) ? parsed.changes : []
  // CLI providers self-report verification result
  const testPassed  = parsed.testPassed != null ? Boolean(parsed.testPassed) : null
  const testOutput  = parsed.testOutput  || null

  const inputPrompt = (aiFix.provider === 'claude-cli' || aiFix.provider === 'gemini-cli')
    ? { prompt: buildCliFixPrompt(aiFix, ctx, workdir, options.previousAttempt || null) }
    : { system: systemPrompt, user: userContent }
  // Include raw response so UI can show it when JSON was non-trivially extracted
  const rawResponseNote = rawResponse && !rawResponse.trimStart().startsWith('{') ? rawResponse : null

  if (changes.length === 0) {
    return { analysis, diff: null, diffSummary: analysis, filesChanged: 0, appliedFiles: [], testPassed, testOutput, inputPrompt, rawResponse: rawResponseNote }
  }

  const appliedFiles = []
  for (const change of changes) {
    if (!change.file || typeof change.content !== 'string') continue
    const fp = path.join(workdir, change.file)
    fs.mkdirSync(path.dirname(fp), { recursive: true })
    fs.writeFileSync(fp, change.content, 'utf8')
    appliedFiles.push(change.file)
    console.log(`[ai-fix] applied: ${change.file}`)
  }

  await exec('git', ['add', '-A'], { cwd: workdir })
  let diff = ''
  try { const r = await exec('git', ['diff', '--cached'], { cwd: workdir }); diff = r.stdout || '' } catch {}

  return { analysis, diff, diffSummary: `Changed ${appliedFiles.length} file(s): ${appliedFiles.join(', ')}`, filesChanged: appliedFiles.length, appliedFiles, testPassed, testOutput, inputPrompt, rawResponse: rawResponseNote }
}

// ── Stage: Verify ──────────────────────────────────────────────────────────

async function stageVerify(verify, ctx, cfg, workdir) {
  const { test } = ctx
  const rawCmd = (verify.command || '').trim() || 'npm test'
  const testCmd = applyTestVars(rawCmd, test, null)

  const envOverrides = {}
  if (verify.env) {
    for (const line of verify.env.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const idx = trimmed.indexOf('=')
      if (idx > 0) envOverrides[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1)
    }
  }

  const verifyCheck = checkCommandAllowlist(testCmd, cfg)
  if (!verifyCheck.ok) {
    console.error(`[verify] BLOCKED — ${verifyCheck.reason}`)
    writeAuditLog(cfg, { event: 'command_blocked', stage: 'verify', reason: verifyCheck.reason, cmd: testCmd })
    throw new Error(`Command blocked by allowlist: ${verifyCheck.reason}`)
  }
  console.log(`[verify] running: ${testCmd}`)
  try {
    const r = await exec('sh', ['-c', testCmd], { cwd: workdir, timeout: 10 * 60 * 1000, env: { ...process.env, ...envOverrides } })
    return { passed: true, output: (r.stdout + r.stderr).trim(), exitCode: 0 }
  } catch (err) {
    return { passed: false, output: err.output || err.message, exitCode: err.exitCode || 1 }
  }
}

// ── Stage: Create PR ───────────────────────────────────────────────────────

async function stageCreatePr(createPr, checkout, resolvedBaseBranch, ctx, cfg, signalId, workdir, diffSummary, options = {}) {
  const apiToken = createPr.apiToken
  if (!apiToken) throw new Error('API token not set — add it to the playbook Create PR settings')

  // Commit if there are changes
  const statusR = await exec('git', ['status', '--porcelain'], { cwd: workdir })
  if ((statusR.stdout || '').trim()) {
    await exec('git', ['add', '-A'], { cwd: workdir })
    await exec('git', ['commit', '-m', `fix: auto-heal for ${ctx.test.name} [signal: ${signalId}]`], { cwd: workdir })
  }

  const branchR = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: workdir })
  const branch = branchR.stdout.trim()

  const shaR = await exec('git', ['rev-parse', 'HEAD'], { cwd: workdir })
  const commitSha = shaR.stdout.trim()

  await exec('git', ['push', 'origin', branch], { cwd: workdir })

  // Resolve remote URL
  let remoteUrl = checkout?.remote
  if (!remoteUrl) {
    const r = await exec('git', ['remote', 'get-url', 'origin'], { cwd: workdir })
    remoteUrl = r.stdout.trim()
  }

  const parsed = parseRemote(remoteUrl)
  const prBody = buildPrBody(ctx, diffSummary, signalId, { ureportUrl: cfg.ureport_url, ...options })
  const prBase = resolvedBaseBranch || createPr.baseBranch
  const rawTitle = createPr.titleTemplate || `fix: auto-heal for {test.name}`
  const prTitle = applyTestVars(rawTitle, ctx.test, null)
  let prUrl = null

  if (parsed.provider === 'github') {
    const resp = await fetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}/pulls`, {
      method: 'POST',
      headers: { Authorization: `token ${apiToken}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json', 'User-Agent': 'ureport-agent' },
      body: JSON.stringify({ title: prTitle, body: prBody, head: branch, base: prBase }),
    })
    const data = await resp.json()
    if (!resp.ok) throw new Error(`GitHub API ${resp.status}: ${data.message}`)
    prUrl = data.html_url
  } else if (parsed.provider === 'bitbucket') {
    const authHeader = createPr.apiUsername
      ? `Basic ${Buffer.from(`${createPr.apiUsername}:${apiToken}`).toString('base64')}`
      : `Bearer ${apiToken}`
    const resp = await fetch(`https://api.bitbucket.org/2.0/repositories/${parsed.workspace}/${parsed.repo}/pullrequests`, {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json', 'User-Agent': 'ureport-agent' },
      body: JSON.stringify({ title: prTitle, description: prBody, source: { branch: { name: branch } }, destination: { branch: { name: prBase } } }),
    })
    const data = await resp.json()
    if (!resp.ok) throw new Error(`Bitbucket API ${resp.status}: ${data.error?.message || JSON.stringify(data)}`)
    prUrl = data.links?.html?.href
  } else {
    throw new Error(`Unsupported git provider — cannot parse remote: ${remoteUrl}. Supported: github.com, bitbucket.org`)
  }

  if (!prUrl) throw new Error('PR created but no URL returned from API')
  console.log(`[create-pr] PR created: ${prUrl}`)
  return { prUrl, branch, commitSha }
}

function parseRemote(remote) {
  const gh = remote.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/)
  if (gh) return { provider: 'github', owner: gh[1], repo: gh[2] }
  const bb = remote.match(/bitbucket\.org[/:]([^/]+)\/([\w.-]+?)(?:\.git)?$/)
  if (bb) return { provider: 'bitbucket', workspace: bb[1], repo: bb[2] }
  return { provider: null }
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

// ── Agent Delegation ───────────────────────────────────────────────────────

async function runAgentDelegation(signalId, playbook, ctx, cfg) {
  const { lane } = ctx
  const provider = playbook.provider || 'claude-cli'

  // Delegation uses a pre-cloned workspace — no checkout step
  const laneDir = `${lane.product}__${lane.type}`
  const workdir = path.join(cfg.repo_path, laneDir)
  if (!fs.existsSync(workdir)) {
    return sendResult(signalId, { status: 'error', error_detail: `workspace not found: ${workdir}. Clone the repo to this path first, or use guided mode with the checkout stage enabled.`, steps_completed: 0, step_outputs: {} })
  }

  sendProgress(signalId, 0, 'delegation', 'running', 'Running CLI agent...', null)

  // Build an aiFix-compatible config from delegation playbook fields.
  // Backend injects stepsBlock + outputFormatBlock into the snapshot;
  // fall back to null (buildCliFixPrompt skips null blocks).
  const aiFix = {
    provider,
    model:             playbook.model            || null,
    instructions:      playbook.prompt           || '',
    stepsBlock:        playbook.stepsBlock        || null,
    outputFormatBlock: playbook.outputFormatBlock || null,
    runHintBlock:      null,
  }

  let aiFixOut
  try {
    aiFixOut = await stageAiFix(aiFix, ctx, cfg, workdir, {})
  } catch (err) {
    sendProgress(signalId, 0, 'delegation', 'failed', err.message, null)
    return sendResult(signalId, { status: 'error', error_detail: err.message, steps_completed: 0, step_outputs: {} })
  }

  sendProgress(signalId, 0, 'delegation', 'done', `Applied ${aiFixOut.filesChanged} file change(s)`, aiFixOut)

  if (aiFixOut.testPassed === false) {
    return sendResult(signalId, {
      status:          'test_failed',
      agent_analysis:  aiFixOut.analysis,
      attempted_diff:  aiFixOut.diff,
      test_output:     aiFixOut.testOutput,
      steps_completed: 1,
      step_outputs:    { delegation: aiFixOut },
    })
  }

  return sendResult(signalId, {
    status:          'completed',
    agent_analysis:  aiFixOut.analysis,
    diff_summary:    aiFixOut.diffSummary,
    test_output:     aiFixOut.testOutput,
    steps_completed: 1,
    step_outputs:    { delegation: aiFixOut },
  })
}

// ── Rerun Job ──────────────────────────────────────────────────────────────

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

    const repoExists = fs.existsSync(path.join(workdir, '.git'))
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

// ── exec utility ───────────────────────────────────────────────────────────

function exec(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env || process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    let timedOut = false
    const timer = opts.timeout ? setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, opts.timeout) : null
    child.on('close', code => {
      if (timer) clearTimeout(timer)
      if (timedOut) { const e = new Error(`timed out: ${cmd} ${args.join(' ')}`); e.output = stdout + stderr; e.exitCode = -1; return reject(e) }
      if (code !== 0) { const e = new Error(`exit ${code}: ${cmd} ${args.join(' ')}\n${stderr || stdout}`); e.output = (stdout + stderr).trim(); e.exitCode = code; return reject(e) }
      resolve({ stdout, stderr })
    })
    child.on('error', reject)
  })
}

// ── Graceful shutdown ──────────────────────────────────────────────────────

function shutdown() {
  console.log('[agent] shutting down...')
  _stopping = true
  if (_reconnectTimer) clearTimeout(_reconnectTimer)
  if (_ws) { if (_ws._hbTimer) clearInterval(_ws._hbTimer); _ws.close(1000, 'agent shutdown') }
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// ── Main ───────────────────────────────────────────────────────────────────

const cfg = loadConfig()
_cfg = cfg
console.log(`[agent] ureport-agent v${VERSION}`)
console.log(`[agent] server:    ${cfg.ureport_url}`)
console.log(`[agent] workspace: ${cfg.repo_path}`)
connect(cfg)
