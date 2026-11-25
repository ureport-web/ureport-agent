'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { startAgent, startPrApi, healJob, AI_FIXED } = require('./helpers/agent-harness')

let agent
let prApi
test.afterEach(async () => {
  if (agent) await agent.stop()
  if (prApi) await prApi.close()
  agent = null; prApi = null
})

const REMOTE = 'git@git.test:owner/repo.git'
const checkout = (more = {}) => ({ enabled: true, remote: REMOTE, branchPrefix: 'fix/auto-', baseBranch: 'main', ...more })
const createPr = (more = {}) => ({ enabled: true, titleTemplate: 'fix: auto-heal {test.name}', baseBranch: 'main', apiToken: 'tok', ...more })
const githubOk = () => prApi.requests.length >= 0 && { status: 201, body: { html_url: 'https://git.test/owner/repo/pull/1' } }
const gitHosts = (provider = 'github') => ({ git_hosts: { 'git.test': { provider, api_url: prApi.url } } })
const ai = (...stdout) => ({ responses: stdout.map((s) => (typeof s === 'string' ? { stdout: s } : s)) })
const workdir = () => path.join(agent.repoPath, 'shop__ui')
const gitLines = () => agent.gitCalls()

describe_('AI fix only', () => {
  test('applies the change, reports the diff and the test result, and writes the file', async () => {
    agent = await startAgent({ ai: ai(AI_FIXED()) })
    const res = await agent.runJob(healJob())
    assert.equal(res.status, 'completed')
    assert.equal(res.diff_summary, 'Changed 1 file(s): tests/a.spec.ts')
    assert.match(res.attempted_diff, /diff --git/)
    assert.equal(res.agent_analysis, 'the selector was wrong')
    assert.equal(res.test_output, '1 passed')
    assert.equal(res.rerun_passed, undefined)
    assert.equal(fs.readFileSync(path.join(agent.repoPath, 'tests/a.spec.ts'), 'utf8'), 'fixed')
    assert.ok(gitLines().includes('add -A'))
    const progress = agent.messagesOf('progress').filter((m) => m.signal_id === 'sig-00000001')
    assert.deepEqual(progress.map((m) => `${m.step_id}:${m.status}`), ['aiFix:running', 'aiFix:done'])
    assert.match(progress[1].message, /test passed/)
  })

  test('a test that passed with no change is reported as flaky', async () => {
    agent = await startAgent({ ai: ai('{"analysis":"passes now","changes":[],"testPassed":true}') })
    const res = await agent.runJob(healJob())
    assert.equal(res.status, 'completed')
    assert.equal(res.rerun_passed, true)
    assert.equal(res.completion_reason, 'flaky')
  })

  test('with no verdict from the AI and no change it just completes', async () => {
    agent = await startAgent({ ai: ai('{"analysis":"unclear"}') })
    const res = await agent.runJob(healJob())
    assert.equal(res.status, 'completed')
    assert.equal(res.rerun_passed, undefined)
  })

  test('reads the answer however the CLI wraps it', async () => {
    const inner = '{"analysis":"wrapped","changes":[],"testPassed":true}'
    for (const stdout of [
      JSON.stringify({ result: inner }),
      '```json\n' + inner + '\n```',
      'Here is my answer:\n' + inner + '\nHope that helps',
    ]) {
      agent = await startAgent({ ai: ai(stdout) })
      const res = await agent.runJob(healJob())
      assert.equal(res.agent_analysis, 'wrapped', stdout)
      await agent.stop(); agent = null
    }
  })

  test('an answer that is not JSON is an error that quotes what came back', async () => {
    agent = await startAgent({ ai: ai('I could not do it') })
    const res = await agent.runJob(healJob())
    assert.equal(res.status, 'error')
    assert.match(res.error_detail, /ai_fix: Claude CLI returned invalid JSON/)
    assert.match(res.error_detail, /I could not do it/)
  })

  test('a CLI that fails is an error', async () => {
    agent = await startAgent({ ai: ai({ stderr: 'boom', code: 2 }) })
    const res = await agent.runJob(healJob())
    assert.equal(res.status, 'error')
    assert.match(res.error_detail, /ai_fix: exit 2: claude/)
    const failed = agent.messagesOf('progress').find((m) => m.status === 'failed')
    assert.match(failed.message, /exit 2/)
    assert.ok(failed.output.inputPrompt.prompt.includes('Fix it'))
  })

  test('a CLI that takes too long is stopped', async () => {
    agent = await startAgent({ yml: { claude_cli_timeout_minutes: 1 }, ai: ai({ stdout: '{}', delayMs: 300000 }) })   // the fake runs at the same 100x speed, so this is 3s there and the 1 minute limit is 0.6s
    const res = await agent.runJob(healJob(), { timeout: 20000 })
    assert.equal(res.status, 'error')
    assert.match(res.error_detail, /timed out: claude/)
  })

  test('an unknown provider is an error', async () => {
    agent = await startAgent()
    const res = await agent.runJob(healJob({ pipeline: { aiFix: { provider: 'gpt-cli' } } }))
    assert.equal(res.status, 'error')
    assert.match(res.error_detail, /Unknown AI provider: gpt-cli/)
  })

  test('the Gemini CLI is called with the model, and its answer is read the same way', async () => {
    agent = await startAgent({ ai: ai(AI_FIXED({ analysis: 'by gemini' })) })
    const res = await agent.runJob(healJob({ pipeline: { aiFix: { provider: 'gemini-cli', model: 'gemini-2.5-pro' } } }))
    assert.equal(res.agent_analysis, 'by gemini')
    const call = agent.aiCalls()[0]
    assert.equal(call.cmd, 'gemini')
    assert.deepEqual(call.args.slice(2), ['--yolo', '--model', 'gemini-2.5-pro'])
  })

  test('the Gemini CLI without a model passes none, and a bad answer names Gemini', async () => {
    agent = await startAgent({ yml: { gemini_cli_timeout_minutes: 5 }, ai: ai('nope') })
    const res = await agent.runJob(healJob({ pipeline: { aiFix: { provider: 'gemini-cli' } } }))
    assert.match(res.error_detail, /Gemini CLI returned invalid JSON/)
    assert.deepEqual(agent.aiCalls()[0].args.slice(2), ['--yolo'])
  })

  test('skips changes that have no file or no text, and creates folders as needed', async () => {
    const changes = [{ file: 'src/deep/new.ts', content: 'x' }, { content: 'no file' }, { file: 'no-content.ts' }, { file: 'num.ts', content: 5 }]
    agent = await startAgent({ ai: ai(JSON.stringify({ analysis: 'a', changes, testPassed: true })) })
    const res = await agent.runJob(healJob())
    assert.equal(res.diff_summary, 'Changed 1 file(s): src/deep/new.ts')
    assert.ok(fs.existsSync(path.join(agent.repoPath, 'src/deep/new.ts')))
    assert.equal(fs.existsSync(path.join(agent.repoPath, 'no-content.ts')), false)
  })

  test('a failing git diff after the change is not fatal', async () => {
    agent = await startAgent({ ai: ai(AI_FIXED()), git: { rules: [{ match: 'diff --cached', code: 1 }] } })
    const res = await agent.runJob(healJob())
    assert.equal(res.status, 'completed')
    assert.equal(res.attempted_diff, '')
  })

  test('the prompt carries the instructions, the error, the steps and the file the CLI should work on', async () => {
    agent = await startAgent({ ai: ai(AI_FIXED()), files: { 'tests/a.spec.ts': 'original' } })
    await agent.runJob(healJob({
      pipeline: { aiFix: { runHintBlock: 'RUN {test.file} for {test.name}', stepsBlock: 'DO {test.file}' } },
      test: { file: '/ci/build/src/tests/a.spec.ts', steps: [{ index: 3, total: 9, status: 'FAIL', detail: 'click' }, { index: 4, total: 9, status: 'PASS', detail: 'done' }] },
    }))
    const prompt = agent.aiCalls()[0].args[agent.aiCalls()[0].args.length - 1]
    for (const part of ['Fix it', 'RUN tests/a.spec.ts for checkout works', 'DO tests/a.spec.ts', 'Product: shop  Type: ui', 'File: tests/a.spec.ts', 'expected 1 to be 2', 'at a.spec.ts:10', 'Steps Around Failure (3–4 of 9)', '[FAIL] click', 'FORMAT']) {
      assert.ok(prompt.includes(part), `prompt should include "${part}"`)
    }
  })

  test('a test with no stack, no file, no steps and no instructions still gets a prompt', async () => {
    agent = await startAgent({ ai: ai(AI_FIXED()) })
    await agent.runJob(healJob({ pipeline: { aiFix: { instructions: '' } }, test: { file: '', stack_trace: '', error_message: '' } }))
    const prompt = agent.aiCalls()[0].args.at(-1)
    assert.ok(prompt.includes('(none)'))
    assert.ok(!prompt.includes('## Stack Trace'))
  })
})

describe_('retrying the AI fix', () => {
  const failing = (n = 1) => JSON.stringify({ analysis: `attempt ${n} analysis`, changes: [{ file: 'tests/a.spec.ts', content: `v${n}` }], testPassed: false, testOutput: `attempt ${n} output` })

  test('a failed attempt is rolled back and the next one is told what happened', async () => {
    agent = await startAgent({ ai: ai(failing(1), AI_FIXED({ analysis: 'second try' })) })
    const res = await agent.runJob(healJob({ pipeline: { aiFix: { maxAttempts: 3 } } }))
    assert.equal(res.status, 'completed')
    assert.equal(res.agent_analysis, 'second try')
    assert.equal(agent.aiCalls().length, 2)
    const second = agent.aiCalls()[1].args.at(-1)
    for (const part of ['PREV', 'PREV-ANALYSIS', 'attempt 1 analysis', 'PREV-OUTPUT', 'attempt 1 output']) assert.ok(second.includes(part), part)
    assert.ok(gitLines().includes('checkout HEAD -- tests/a.spec.ts'))
    const running = agent.messagesOf('progress').filter((m) => /attempt/.test(m.message))
    assert.ok(running.length >= 1)
    const done = agent.messagesOf('progress').find((m) => m.status === 'done')
    assert.equal(done.output.attempts.length, 2)
  })

  test('a rollback that fails does not stop the retry', async () => {
    agent = await startAgent({ ai: ai(failing(1), AI_FIXED()), git: { rules: [{ match: 'checkout HEAD --', code: 1 }] } })
    const res = await agent.runJob(healJob({ pipeline: { aiFix: { maxAttempts: 2 } } }))
    assert.equal(res.status, 'completed')
  })

  test('a failing attempt with nothing applied has nothing to roll back', async () => {
    agent = await startAgent({ ai: ai('{"analysis":"no change","changes":[],"testPassed":false,"testOutput":"red"}', AI_FIXED()) })
    const res = await agent.runJob(healJob({ pipeline: { aiFix: { maxAttempts: 2 } } }))
    assert.equal(res.status, 'completed')
    assert.equal(gitLines().some((l) => l.startsWith('checkout HEAD --')), false)
  })

  test('when every attempt fails the signal ends as test_failed with the last diff', async () => {
    agent = await startAgent({ ai: ai(failing(1), failing(2)) })
    const res = await agent.runJob(healJob({ pipeline: { aiFix: { maxAttempts: 2 } } }))
    assert.equal(res.status, 'test_failed')
    assert.equal(res.test_output, 'attempt 2 output')
    assert.equal(res.agent_analysis, 'attempt 2 analysis')
    assert.match(res.attempted_diff, /diff --git/)
    assert.equal(res.pr_url, undefined)
    const failed = agent.messagesOf('progress').find((m) => m.status === 'failed')
    assert.match(failed.message, /still failing after 2 attempt/)
  })

  test('the number of attempts is capped at five, and one attempt means no retry', async () => {
    agent = await startAgent({ ai: ai(failing(1)) })
    await agent.runJob(healJob({ pipeline: { aiFix: { maxAttempts: 9 } } }))
    assert.equal(agent.aiCalls().length, 5)
    await agent.stop()
    agent = await startAgent({ ai: ai(failing(1)) })
    const res = await agent.runJob(healJob({ pipeline: { aiFix: { maxAttempts: 1 } } }))
    assert.equal(res.status, 'test_failed')
    assert.equal(agent.aiCalls().length, 1)
  })

  test('with createOnTestFailed a work-in-progress pull request is opened for the failed fix', async () => {
    prApi = await require('./helpers/agent-harness').startPrApi(() => githubOk())
    agent = await startAgent({ yml: gitHosts(), ai: ai(failing(1)), git: { rules: [{ match: 'rev-list --count', stdout: '2\n' }] } })
    const res = await agent.runJob(healJob({ pipeline: { checkout: checkout(), aiFix: { maxAttempts: 1 }, createPr: createPr({ createOnTestFailed: true }) } }))
    assert.equal(res.status, 'test_failed')
    assert.equal(res.pr_url, 'https://git.test/owner/repo/pull/1')
    const pr = prApi.requests[0].body
    assert.match(pr.title, /^\[WIP\] fix: auto-heal checkout works$/)
    assert.match(pr.body, /Work in Progress/)
    assert.match(pr.body, /attempt 1 output/)
  })

  test('if even the work-in-progress pull request cannot be opened the signal still ends as test_failed', async () => {
    prApi = await require('./helpers/agent-harness').startPrApi(() => ({ status: 500, body: { message: 'down' } }))
    agent = await startAgent({ yml: gitHosts(), ai: ai(failing(1)) })
    const res = await agent.runJob(healJob({ pipeline: { checkout: checkout(), aiFix: { maxAttempts: 1 }, createPr: createPr({ createOnTestFailed: true }) } }))
    assert.equal(res.status, 'test_failed')
    assert.equal(res.pr_url, undefined)
    assert.match(agent.output, /WIP PR creation failed/)
  })

  test('a failing test is not given a work-in-progress pull request unless that is switched on', async () => {
    prApi = await require('./helpers/agent-harness').startPrApi(() => githubOk())
    agent = await startAgent({ yml: gitHosts(), ai: ai(failing(1)) })
    await agent.runJob(healJob({ pipeline: { checkout: checkout(), aiFix: { maxAttempts: 1 }, createPr: createPr() } }))
    assert.equal(prApi.requests.length, 0)
  })
})

describe_('a pull request the AI opened itself', () => {
  const withPr = (more = {}) => AI_FIXED({ prUrl: 'https://git.test/owner/repo/pull/7', branch: 'QVF-12-fix-selector', ...more })

  test('is reported as pr_created with its URL and branch, with the Create PR stage off', async () => {
    agent = await startAgent({ ai: ai(withPr()) })
    const res = await agent.runJob(healJob({ pipeline: { aiFix: { maxAttempts: 1 } } }))
    assert.equal(res.status, 'pr_created')
    assert.equal(res.pr_url, 'https://git.test/owner/repo/pull/7')
    assert.equal(res.branch, 'QVF-12-fix-selector')
    assert.equal(res.rerun_passed, undefined)
  })

  test('is not opened again by the Create PR stage', async () => {
    prApi = await require('./helpers/agent-harness').startPrApi(() => githubOk())
    agent = await startAgent({ yml: gitHosts(), ai: ai(withPr()) })
    const res = await agent.runJob(healJob({ pipeline: { checkout: checkout(), aiFix: { maxAttempts: 1 }, createPr: createPr() } }))
    assert.equal(res.pr_url, 'https://git.test/owner/repo/pull/7')
    assert.equal(prApi.requests.length, 0)
  })

  test('is found in the AI\'s own text when it forgot the prUrl field', async () => {
    agent = await startAgent({ ai: ai(AI_FIXED({ analysis: 'Fixed the selector. Opened https://bitbucket.org/acme/repo/pull-requests/42.' })) })
    const res = await agent.runJob(healJob({ pipeline: { aiFix: { maxAttempts: 1 } } }))
    assert.equal(res.status, 'pr_created')
    assert.equal(res.pr_url, 'https://bitbucket.org/acme/repo/pull-requests/42')
  })

  test('a link only found in the text is left to the Create PR stage when that stage is on', async () => {
    prApi = await require('./helpers/agent-harness').startPrApi(() => githubOk())
    agent = await startAgent({ yml: gitHosts(), ai: ai(AI_FIXED({ analysis: 'see https://git.test/owner/repo/pull/3 for context' })), git: { rules: [{ match: 'rev-list --count', stdout: '2\n' }] } })
    const res = await agent.runJob(healJob({ pipeline: { checkout: checkout(), aiFix: { maxAttempts: 1 }, createPr: createPr() } }))
    assert.equal(res.status, 'pr_created')
    assert.equal(prApi.requests.length, 1)
  })

  test('is ignored when the test did not pass, or the answer is not a URL', async () => {
    agent = await startAgent({ ai: ai(withPr({ testPassed: false })) })
    assert.equal((await agent.runJob(healJob({ pipeline: { aiFix: { maxAttempts: 1 } } }))).status, 'test_failed')
    await agent.stop()
    agent = await startAgent({ ai: ai(withPr({ prUrl: 'created it, see Bitbucket' })) })
    const res = await agent.runJob(healJob({ pipeline: { aiFix: { maxAttempts: 1 } } }))
    assert.equal(res.status, 'completed')
    assert.equal(res.pr_url, undefined)
  })
})

describe_('checkout', () => {
  test('clones the repository, branches off the base and names the branch after the test and signal', async () => {
    agent = await startAgent({ ai: ai(AI_FIXED()) })
    const res = await agent.runJob(healJob({ id: 'sig-abcdefgh12345678', pipeline: { checkout: checkout() } }))
    assert.equal(res.status, 'completed')
    const lines = gitLines()
    assert.ok(lines.includes(`clone ${REMOTE} ${workdir()}`))
    assert.ok(lines.includes('reset --hard origin/main'))
    assert.ok(lines.includes('checkout -b fix/auto-checkout-works/12345678'))
    const done = agent.messagesOf('progress').find((m) => m.step_id === 'checkout' && m.status === 'done')
    assert.equal(done.output.branch, 'fix/auto-checkout-works/12345678')
    assert.equal(agent.aiCalls()[0].cwd, fs.realpathSync(workdir()))
  })

  test('uses the repository default branch when the configured base branch is not what was cloned', async () => {
    agent = await startAgent({ ai: ai(AI_FIXED()), git: { rules: [{ match: 'rev-parse --abbrev-ref HEAD', stdout: 'develop\n' }] } })
    await agent.runJob(healJob({ pipeline: { checkout: checkout({ baseBranch: 'main' }) } }))
    assert.ok(gitLines().includes('reset --hard origin/develop'))
  })

  test('uses a default branch prefix and a short test slug when none is given', async () => {
    agent = await startAgent({ ai: ai(AI_FIXED()) })
    await agent.runJob(healJob({ id: 'sig-00000009', pipeline: { checkout: checkout({ branchPrefix: '' }) }, test: { name: '  Weird / Name!!  ' } }))
    assert.ok(gitLines().some((l) => l === 'checkout -b fix/auto-weird-name/00000009'))
  })

  test('a repository that is already there is cleaned, fetched and reused', async () => {
    fs.mkdirSync(path.join(path.dirname(__dirname), '.keep'), { recursive: true })
    agent = await startAgent({ ai: ai(AI_FIXED()), files: { 'shop__ui/.git/HEAD': 'ref' } })
    await agent.runJob(healJob({ pipeline: { checkout: checkout() } }))
    const lines = gitLines()
    assert.equal(lines.some((l) => l.startsWith('clone')), false)
    for (const expected of ['reset --hard HEAD', 'clean -fd', 'fetch origin', 'checkout main']) assert.ok(lines.includes(expected), expected)
  })

  test('cleaning a dirty repository may fail without stopping the job', async () => {
    agent = await startAgent({ ai: ai(AI_FIXED()), files: { 'shop__ui/.git/HEAD': 'ref' }, git: { rules: [{ match: 'reset --hard HEAD', code: 1 }, { match: 'clean -fd', code: 1 }] } })
    assert.equal((await agent.runJob(healJob({ pipeline: { checkout: checkout() } }))).status, 'completed')
  })

  test('falls back to the remote default branch when the base branch does not exist', async () => {
    agent = await startAgent({
      ai: ai(AI_FIXED()), files: { 'shop__ui/.git/HEAD': 'ref' },
      git: { rules: [{ match: 'checkout main', code: 1, times: 1 }, { match: 'symbolic-ref --short refs/remotes/origin/HEAD', stdout: 'origin/trunk\n' }] },
    })
    await agent.runJob(healJob({ pipeline: { checkout: checkout() } }))
    const lines = gitLines()
    assert.ok(lines.includes('checkout trunk'))
    assert.ok(lines.includes('reset --hard origin/trunk'))
  })

  test('fails when neither the base branch nor a remote default can be found', async () => {
    agent = await startAgent({
      files: { 'shop__ui/.git/HEAD': 'ref' },
      git: { rules: [{ match: 'checkout main', code: 1 }, { match: 'symbolic-ref', code: 1 }] },
    })
    const res = await agent.runJob(healJob({ pipeline: { checkout: checkout() } }))
    assert.equal(res.status, 'error')
    assert.match(res.error_detail, /checkout: Branch 'main' not found and could not detect remote default branch/)
  })

  test('fails when there is no repository to clone from', async () => {
    agent = await startAgent()
    const res = await agent.runJob(healJob({ pipeline: { checkout: checkout({ remote: '' }) } }))
    assert.equal(res.status, 'error')
    assert.match(res.error_detail, /checkout.remote is not set in the playbook/)
  })

  test('removes a folder that is not a usable repository and clones again', async () => {
    agent = await startAgent({ ai: ai(AI_FIXED()), files: { 'shop__ui/leftover.txt': 'junk' } })
    await agent.runJob(healJob({ pipeline: { checkout: checkout() } }))
    assert.ok(gitLines().some((l) => l.startsWith('clone')))
    assert.match(agent.output, /not a usable git repo/)
  })

  test('a clone that fails is reported with the git error', async () => {
    agent = await startAgent({ git: { rules: [{ match: 'clone', code: 128, stderr: 'fatal: repository not found' }] } })
    const res = await agent.runJob(healJob({ pipeline: { checkout: checkout() } }))
    assert.equal(res.status, 'error')
    assert.match(res.error_detail, /checkout: exit 128: git clone/)
    assert.deepEqual(agent.messagesOf('progress').map((m) => `${m.step_id}:${m.status}`).slice(-1), ['checkout:failed'])
  })

  test('runs the install command in the repository, and a failing one stops the job', async () => {
    agent = await startAgent({ ai: ai(AI_FIXED()) })
    await agent.runJob(healJob({ pipeline: { checkout: checkout({ installCommand: 'echo installed > marker.txt' }) } }))
    assert.equal(fs.readFileSync(path.join(workdir(), 'marker.txt'), 'utf8').trim(), 'installed')
    await agent.stop()
    agent = await startAgent({ ai: ai(AI_FIXED()) })
    const res = await agent.runJob(healJob({ pipeline: { checkout: checkout({ installCommand: 'exit 3' }) } }))
    assert.equal(res.status, 'error')
    assert.match(res.error_detail, /checkout: exit 3/)
    assert.equal(agent.aiCalls().length, 0)
  })
})

describe_('create pull request', () => {
  test('commits, pushes and opens the pull request, then reports it', async () => {
    prApi = await require('./helpers/agent-harness').startPrApi(() => githubOk())
    agent = await startAgent({ yml: gitHosts(), ai: ai(AI_FIXED()), git: { rules: [{ match: 'rev-parse --abbrev-ref HEAD', after: 1, stdout: 'fix/auto-checkout-works/pr000001\n' }] } })
    const res = await agent.runJob(healJob({ id: 'sig-pr000001', pipeline: { checkout: checkout(), createPr: createPr() } }))
    assert.equal(res.status, 'pr_created')
    assert.equal(res.pr_url, 'https://git.test/owner/repo/pull/1')
    assert.equal(res.branch, 'fix/auto-checkout-works/pr000001')
    assert.equal(res.diff_summary, 'Changed 1 file(s): tests/a.spec.ts')
    const lines = gitLines()
    assert.ok(lines.some((l) => l.startsWith('commit -m fix: auto-heal for checkout works [signal: sig-pr000001]')))
    assert.ok(lines.includes('push origin fix/auto-checkout-works/pr000001'))
    const req = prApi.requests[0]
    assert.equal(req.url, '/repos/owner/repo/pulls')
    assert.equal(req.headers.authorization, 'token tok')
    assert.equal(req.body.title, 'fix: auto-heal checkout works')
    assert.equal(req.body.base, 'main')
    assert.match(req.body.body, /Auto-Heal Fix/)
    assert.match(req.body.body, /the selector was wrong/)
    assert.match(req.body.body, /expected 1 to be 2/)
    assert.match(req.body.body, new RegExp(`${agent.child.pid ? '127.0.0.1' : ''}.*launches\\?x=1`))
  })

  test('uses the default title when the playbook has none, and does not commit when nothing changed on disk', async () => {
    prApi = await require('./helpers/agent-harness').startPrApi(() => githubOk())
    agent = await startAgent({ yml: gitHosts(), ai: ai(AI_FIXED()), git: { rules: [{ match: 'status --porcelain', stdout: '' }] } })
    await agent.runJob(healJob({ pipeline: { checkout: checkout(), createPr: createPr({ titleTemplate: '' }) } }))
    assert.equal(prApi.requests[0].body.title, 'fix: auto-heal for checkout works')
    assert.equal(gitLines().some((l) => l.startsWith('commit')), false)
  })

  test('refuses without a token', async () => {
    agent = await startAgent({ ai: ai(AI_FIXED()) })
    const res = await agent.runJob(healJob({ pipeline: { checkout: checkout(), createPr: createPr({ apiToken: '' }) } }))
    assert.equal(res.status, 'error')
    assert.match(res.error_detail, /create_pr: API token not set/)
  })

  test('finds the repository from the origin remote when checkout is off, and fails when there is none', async () => {
    prApi = await require('./helpers/agent-harness').startPrApi(() => githubOk())
    agent = await startAgent({ yml: gitHosts(), ai: ai(AI_FIXED()) })
    const ok = await agent.runJob(healJob({ pipeline: { createPr: createPr() } }))
    assert.equal(ok.status, 'pr_created')
    assert.ok(gitLines().includes('remote get-url origin'))
    await agent.stop()
    agent = await startAgent({ yml: gitHosts(), ai: ai(AI_FIXED()), git: { rules: [{ match: 'remote get-url origin', code: 2 }] } })
    const none = await agent.runJob(healJob({ pipeline: { createPr: createPr() } }))
    assert.match(none.error_detail, /No git remote found/)
  })

  test('refuses a git host it does not know before pushing anything', async () => {
    agent = await startAgent({ ai: ai(AI_FIXED()) })
    const res = await agent.runJob(healJob({ pipeline: { checkout: checkout({ remote: 'git@unknown.example:o/r.git' }), createPr: createPr() } }))
    assert.equal(res.status, 'error')
    assert.match(res.error_detail, /Unsupported git host "unknown.example"/)
    assert.equal(gitLines().some((l) => l.startsWith('push')), false)
  })

  test('when the AI changed nothing the branch matches the base: no pull request, the signal completes', async () => {
    prApi = await require('./helpers/agent-harness').startPrApi(() => githubOk())
    agent = await startAgent({ yml: gitHosts(), ai: ai('{"analysis":"nothing to do","changes":[],"testPassed":true}'), git: { rules: [{ match: 'rev-list --count', stdout: '0\n' }] } })
    const res = await agent.runJob(healJob({ pipeline: { checkout: checkout(), createPr: createPr() } }))
    assert.equal(res.status, 'completed')
    assert.equal(res.rerun_passed, true)
    const skipped = agent.messagesOf('progress').filter((m) => m.step_id === 'createPr').at(-1)
    assert.equal(skipped.status, 'skipped')
    assert.equal(gitLines().some((l) => l.startsWith('push')), false)
  })

  test('if the base branch cannot be compared locally the push goes ahead', async () => {
    prApi = await require('./helpers/agent-harness').startPrApi(() => githubOk())
    agent = await startAgent({ yml: gitHosts(), ai: ai(AI_FIXED()), git: { rules: [{ match: 'rev-list --count', code: 128 }] } })
    const res = await agent.runJob(healJob({ pipeline: { checkout: checkout(), createPr: createPr() } }))
    assert.equal(res.status, 'pr_created')
  })

  test('with no base branch anywhere the comparison is skipped', async () => {
    prApi = await require('./helpers/agent-harness').startPrApi(() => githubOk())
    agent = await startAgent({ yml: gitHosts(), ai: ai(AI_FIXED()) })
    const res = await agent.runJob(healJob({ pipeline: { createPr: createPr({ baseBranch: '' }) } }))
    assert.equal(res.status, 'pr_created')
    assert.equal(gitLines().some((l) => l.startsWith('rev-list')), false)
  })

  test('a rejected pull request is an error with the API answer', async () => {
    prApi = await require('./helpers/agent-harness').startPrApi(() => ({ status: 422, body: { message: 'Validation Failed' } }))
    agent = await startAgent({ yml: gitHosts(), ai: ai(AI_FIXED()) })
    const res = await agent.runJob(healJob({ pipeline: { checkout: checkout(), createPr: createPr() } }))
    assert.equal(res.status, 'error')
    assert.match(res.error_detail, /create_pr: GitHub API 422: Validation Failed/)
    assert.deepEqual(res.attempted_diff && true, true)
  })

  test('works with a GitLab host', async () => {
    prApi = await require('./helpers/agent-harness').startPrApi((req) => (req.url.includes('merge_requests') ? { status: 201, body: { web_url: 'https://git.test/owner/repo/-/merge_requests/3' } } : null))
    agent = await startAgent({ yml: gitHosts('gitlab'), ai: ai(AI_FIXED()) })
    const res = await agent.runJob(healJob({ pipeline: { checkout: checkout(), createPr: createPr() } }))
    assert.equal(res.pr_url, 'https://git.test/owner/repo/-/merge_requests/3')
    assert.equal(prApi.requests[0].headers['private-token'], 'tok')
  })

  test('works with a Bitbucket host, with and without a username', async () => {
    prApi = await require('./helpers/agent-harness').startPrApi((req) => (req.url.includes('pullrequests') ? { status: 201, body: { links: { html: { href: 'https://git.test/owner/repo/pull-requests/9' } } } } : { status: 404, body: {} }))
    agent = await startAgent({ yml: gitHosts('bitbucket'), ai: ai(AI_FIXED()) })
    const res = await agent.runJob(healJob({ pipeline: { checkout: checkout(), createPr: createPr({ apiUsername: 'bob' }) } }))
    assert.equal(res.pr_url, 'https://git.test/owner/repo/pull-requests/9')
    const post = prApi.requests.find((r) => r.method === 'POST')
    assert.equal(post.headers.authorization, `Basic ${Buffer.from('bob:tok').toString('base64')}`)
  })
})

describe_('stages that are switched off', () => {
  test('a pipeline with no AI fix only checks out and completes', async () => {
    agent = await startAgent()
    const res = await agent.runJob(healJob({ pipeline: { checkout: checkout(), aiFix: false } }))
    assert.equal(res.status, 'completed')
    assert.equal(agent.aiCalls().length, 0)
    assert.equal(res.steps_completed, 1)
  })

  test('a pipeline with nothing switched on completes at once', async () => {
    agent = await startAgent()
    const res = await agent.runJob(healJob({ pipeline: { aiFix: false } }))
    assert.equal(res.status, 'completed')
    assert.equal(res.steps_completed, 0)
  })

  test('with checkout off the AI works in repo_path itself', async () => {
    agent = await startAgent({ ai: ai(AI_FIXED()) })
    await agent.runJob(healJob())
    assert.equal(agent.aiCalls()[0].cwd, fs.realpathSync(agent.repoPath))
  })
})

describe_('credentials for a job', () => {
  test('a variable the playbook needs and the agent does not have fails the job before anything runs', async () => {
    agent = await startAgent({ ai: ai(AI_FIXED()), unsetEnv: ['STAGE_USER'] })
    const res = await agent.runJob(healJob({ playbook: { requiredEnv: ['STAGE_USER'] } }))
    assert.equal(res.status, 'error')
    assert.match(res.error_detail, /Missing environment variable\(s\) on the agent: STAGE_USER/)
    assert.equal(agent.aiCalls().length, 0)
  })

  test('values from the env file or the shell reach the AI, are named in its prompt and are hidden in what the agent reports', async () => {
    agent = await startAgent({
      envFile: 'STAGE_PASSWORD=hunter22\n',
      env: { STAGE_USER: 'qa-bot' },
      ai: ai(AI_FIXED({ analysis: 'logged in as qa-bot with hunter22', testOutput: 'password hunter22' })),
      yml: { audit_log: 'audit.log' },
    })
    const res = await agent.runJob(healJob({ playbook: { requiredEnv: ['STAGE_USER', 'STAGE_PASSWORD'] } }))
    const call = agent.aiCalls()[0]
    assert.equal(call.env.STAGE_USER, 'qa-bot')
    assert.equal(call.env.STAGE_PASSWORD, 'hunter22')
    const prompt = call.args.at(-1)
    assert.ok(prompt.includes('STAGE_USER, STAGE_PASSWORD'))
    assert.ok(!prompt.includes('hunter22'))
    assert.ok(!JSON.stringify(res).includes('hunter22'))
    assert.ok(!JSON.stringify(agent.received).includes('hunter22'))
    assert.equal(res.agent_analysis, 'logged in as *** with ***')   // both declared values are hidden
    assert.ok(!fs.readFileSync(path.join(agent.dir, 'audit.log'), 'utf8').includes('hunter22'))
  })

  test('a job that does not list a variable never sees it, and the next job starts clean', async () => {
    agent = await startAgent({ envFile: 'STAGE_PASSWORD=hunter22\n', ai: ai(AI_FIXED()) })
    await agent.runJob(healJob({ id: 'sig-a', playbook: { requiredEnv: ['STAGE_PASSWORD'] } }))
    await agent.runJob(healJob({ id: 'sig-b' }))
    const calls = agent.aiCalls()
    assert.equal(calls[0].env.STAGE_PASSWORD, 'hunter22')
    assert.equal(calls[1].env.STAGE_PASSWORD, undefined)
    assert.ok(!calls[1].args.at(-1).includes('Environment variables'))
  })
})

function describe_(name, fn) { test.describe(name, fn) }
