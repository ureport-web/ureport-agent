'use strict'

// The AI fix stage: builds the prompt, runs the Claude or Gemini CLI and applies what it answers.

const fs = require('fs')
const path = require('path')
const state = require('./state')
const { exec } = require('./exec')
const { jobEnv } = require('./job-env')

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
  if (state.jobEnvNames.length) {
    lines.push('## Environment variables')
    lines.push(`These are set in your environment: ${state.jobEnvNames.join(', ')}. Read them from the environment (for example process.env.NAME) when the test or its run command needs them.`)
    lines.push('They hold credentials. Never print their values, never write them into files, commits, logs or the pull request, and never include them in your answer.')
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
    const r = await exec('claude', ['--print', '--output-format', 'json', cliPrompt], { timeout: cliTimeout, cwd: workdir, env: jobEnv() })
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
    const r = await exec('gemini', ['-p', cliPrompt, '--yolo', ...modelArgs], { timeout: cliTimeout, cwd: workdir, env: jobEnv() })
    rawResponse = (r.stdout || '').trim()
    parsed = parseAiJsonResponse(rawResponse, 'Gemini CLI')
  } else {
    throw new Error(`Unknown AI provider: ${provider}. Supported: claude-cli, gemini-cli`)
  }

  return { parsed, rawResponse, systemPrompt, userContent }
}

// A pull request link as the hosts print it: GitHub /pull/N, Bitbucket /pull-requests/N, GitLab /merge_requests/N
const PR_URL_PATTERN = /https?:\/\/[^\s"'<>)\]]+\/(?:pull|pull-requests|merge_requests)\/\d+[^\s"'<>)\]]*/gi

/** The last pull request link in the texts: the AI names the one it just opened last. */
function findPullRequestUrl(...texts) {
  let found = null
  for (const text of texts) {
    const all = typeof text === 'string' ? text.match(PR_URL_PATTERN) : null
    if (all) found = all[all.length - 1].replace(/[.,;:]+$/, '')
  }
  return found
}

async function stageAiFix(aiFix, ctx, cfg, workdir, options = {}) {
  const { parsed, rawResponse, systemPrompt, userContent } = await callAiFix(aiFix, ctx, cfg, workdir, options)
  const analysis    = parsed.analysis || ''
  const changes     = Array.isArray(parsed.changes) ? parsed.changes : []
  // CLI providers self-report verification result
  const testPassed  = parsed.testPassed != null ? Boolean(parsed.testPassed) : null
  const testOutput  = parsed.testOutput  || null
  // A pull request the AI opened itself, when the playbook's instructions ask it to (the Create PR stage is then off)
  const prUrl       = typeof parsed.prUrl === 'string' && /^https?:\/\/\S+$/.test(parsed.prUrl.trim()) ? parsed.prUrl.trim() : null
  let prBranch      = prUrl && typeof parsed.branch === 'string' && parsed.branch.trim() ? parsed.branch.trim() : null
  // The AI opened a PR but left it out of the JSON: take the link from what it wrote, and the branch from the repo
  let prUrlFound = null
  if (!prUrl) {
    prUrlFound = findPullRequestUrl(parsed.analysis, rawResponse)
    if (prUrlFound) {
      try { prBranch = (await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: workdir })).stdout.trim() || null } catch { prBranch = null }
    }
  }

  const inputPrompt = (aiFix.provider === 'claude-cli' || aiFix.provider === 'gemini-cli')
    ? { prompt: buildCliFixPrompt(aiFix, ctx, workdir, options.previousAttempt || null) }
    : { system: systemPrompt, user: userContent }
  // Include raw response so UI can show it when JSON was non-trivially extracted
  const rawResponseNote = rawResponse && !rawResponse.trimStart().startsWith('{') ? rawResponse : null

  if (changes.length === 0) {
    return { analysis, diff: null, diffSummary: analysis, filesChanged: 0, appliedFiles: [], testPassed, testOutput, prUrl: prUrl || prUrlFound, prUrlFromText: !prUrl && !!prUrlFound, prBranch, inputPrompt, rawResponse: rawResponseNote }
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

  return { analysis, diff, diffSummary: `Changed ${appliedFiles.length} file(s): ${appliedFiles.join(', ')}`, filesChanged: appliedFiles.length, appliedFiles, testPassed, testOutput, prUrl: prUrl || prUrlFound, prUrlFromText: !prUrl && !!prUrlFound, prBranch, inputPrompt, rawResponse: rawResponseNote }
}

module.exports = { applyTestVars, buildCliFixPrompt, findPullRequestUrl, stageAiFix }
