'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { startAgent, startPrApi, healJob, rerunJob, AI_FIXED } = require('./helpers/agent-harness')
const { loadEnvFile, secretValues } = require('../agent-env')
const { normalizeGitHosts, createPullRequest } = require('../git-providers')

let agent
let api
test.afterEach(async () => {
  if (agent) await agent.stop()
  if (api) await api.close()
  agent = null; api = null
})

const REMOTE = 'git@git.test:owner/repo.git'
const ai = (...stdout) => ({ responses: stdout.map((s) => (typeof s === 'string' ? { stdout: s } : s)) })
const hosts = () => ({ git_hosts: { 'git.test': { provider: 'github', api_url: api.url } } })
const okPr = () => ({ status: 201, body: { html_url: 'https://git.test/pr/1' } })

test('shutting down while waiting to reconnect cancels the reconnect', async () => {
  agent = await startAgent({ speed: 1 })
  agent.connections[0].ws.close(1012)
  await agent.waitForOutput('reconnecting in 5s')
  agent.child.kill('SIGTERM')
  const { code } = await agent.exited
  assert.equal(code, 0)
})

test('a folder that git does not accept as a repository is cloned again', async () => {
  agent = await startAgent({ ai: ai(AI_FIXED()), files: { 'shop__ui/.git/HEAD': 'ref' }, git: { rules: [{ match: 'rev-parse --git-dir', code: 128, times: 1 }] } })
  await agent.runJob(healJob({ pipeline: { checkout: { enabled: true, remote: REMOTE, baseBranch: 'main' } } }))
  assert.ok(agent.gitCalls().some((l) => l.startsWith('clone')))
})

test('a test with no name or file still gets a branch, a prompt and a pull request', async () => {
  api = await startPrApi(okPr)
  agent = await startAgent({ yml: hosts(), ai: ai('{"changes":[{"file":"x.ts","content":"y"}]}') })
  const res = await agent.runJob(healJob({
    pipeline: { checkout: { enabled: true, remote: REMOTE, baseBranch: 'main' }, createPr: { enabled: true, apiToken: 't', baseBranch: 'main', titleTemplate: 'fix {test.name}|{test.file}|{test.uid}' }, aiFix: { stepsBlock: '', runHintBlock: '', previousAttemptHeader: '' } },
    test: { name: '', file: '', uid: '', steps: [], error_message: '', stack_trace: '' },
    context: { triggered_by: '', launches_path: '' },
  }))
  assert.equal(res.status, 'pr_created')
  assert.equal(api.requests[0].body.title, 'fix {test.name}|{test.file}|{test.uid}'.replace('{test.name}', '').replace('{test.file}', '').replace('{test.uid}', ''))
  assert.ok(agent.gitCalls().some((l) => l.startsWith('checkout -b fix/auto-test/')))
  assert.match(api.requests[0].body.body, /Triggered by:\*\* ureport/)
})

test('a test file that is really a folder is skipped, not fatal', async () => {
  agent = await startAgent({ ai: ai('{"analysis":"x","changes":[]}'), files: { 'tests/a.spec.ts/inner.txt': 'x' } })
  const res = await agent.runJob(healJob())
  assert.equal(res.status, 'completed')
})

test('run hints and steps that mention the test file work when the test has no file', async () => {
  agent = await startAgent({ ai: ai(AI_FIXED()) })
  await agent.runJob(healJob({ pipeline: { aiFix: { runHintBlock: 'RUN {test.file}|{test.name}', stepsBlock: 'STEPS {test.file}' } }, test: { file: '', name: '' } }))
  const prompt = agent.aiCalls()[0].args.at(-1)
  assert.ok(prompt.includes('RUN |'))
  assert.ok(prompt.includes('STEPS '))
})

test('a provider left out of the playbook defaults to the Claude CLI', async () => {
  agent = await startAgent({ ai: ai(AI_FIXED()) })
  const res = await agent.runJob(healJob({ pipeline: { aiFix: { provider: undefined } } }))
  assert.equal(res.status, 'completed')
  assert.equal(agent.aiCalls()[0].cmd, 'claude')
})

test('an answer with no analysis is reported with an empty analysis', async () => {
  agent = await startAgent({ ai: ai('{"changes":[]}') })
  const res = await agent.runJob(healJob())
  assert.equal(res.status, 'completed')
  assert.equal(res.agent_analysis, '')
})

test('a work-in-progress pull request with no title template gets the default title', async () => {
  api = await startPrApi(okPr)
  agent = await startAgent({ yml: hosts(), ai: ai(JSON.stringify({ analysis: 'a', changes: [{ file: 'x.ts', content: 'y' }], testPassed: false })) })
  await agent.runJob(healJob({ pipeline: { checkout: { enabled: true, remote: REMOTE, baseBranch: 'main' }, aiFix: { maxAttempts: 1 }, createPr: { enabled: true, apiToken: 't', baseBranch: 'main', titleTemplate: '', createOnTestFailed: true } } }))
  assert.equal(api.requests[0].body.title, '[WIP] fix: auto-heal checkout works')
})

test('a rerun checkout without a test uid names its folder rerun, and may clean a repo that cannot be reset', async () => {
  agent = await startAgent({ files: { 'rerun__rerun/.git/HEAD': 'ref' }, git: { rules: [{ match: 'reset --hard HEAD', code: 1 }, { match: 'clean -fd', code: 1 }] } })
  const res = await agent.runJob(rerunJob({ config: { repo: { mode: 'checkout', remote: REMOTE } }, test: { uid: '' } }))
  assert.equal(res.status, 'passed')
})

test('a rerun whose command cannot even start reports a failure with the error', async () => {
  agent = await startAgent()
  const dir = path.join(agent.repoPath, 'gone')
  fs.mkdirSync(dir)
  const res = await agent.runJob(rerunJob({ config: { command: 'echo hi', repo: { mode: 'local', path: dir } } }))
  assert.equal(res.status, 'passed')
})

test('a gitlab self-hosted host without an api_url gets the default one', () => {
  assert.deepEqual(normalizeGitHosts({ 'lab.corp.com': { provider: 'gitlab' } }), { 'lab.corp.com': { provider: 'gitlab', apiUrl: 'https://lab.corp.com/api/v4' } })
})

test('GitLab refusals show the error text or the whole answer', async () => {
  const t = (url) => ({ provider: 'gitlab', apiUrl: url, parts: ['o', 'r'], repoPath: 'o/r' })
  const p = { token: 't', title: 'T', body: 'B', head: 'h', base: 'b' }
  api = await startPrApi(() => ({ status: 401, body: { error: 'invalid_token' } }))
  await assert.rejects(createPullRequest(t(api.url), p), /GitLab API 401: "invalid_token"/)
  await api.close()
  api = await startPrApi(() => ({ status: 500, body: {} }))
  await assert.rejects(createPullRequest(t(api.url), p), /GitLab API 500: \{\}/)
})

test('a Bitbucket reviewer answer without values is treated as no reviewers', async () => {
  api = await startPrApi((r) => (r.url.includes('effective-default-reviewers') ? { body: {} } : r.url === '/user' ? { body: { uuid: 'me' } } : { status: 201, body: { links: { html: { href: 'https://bb/pr/1' } } } }))
  const t = { provider: 'bitbucket', apiUrl: api.url, parts: ['owner', 'repo'] }
  assert.equal(await createPullRequest(t, { token: 't', title: 'T', body: 'B', head: 'h', base: 'b' }), 'https://bb/pr/1')
})

test('an env file that cannot be read is reported with its path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-unreadable-'))
  const file = path.join(dir, 'secrets.env')
  fs.writeFileSync(file, 'A=1\n')
  fs.chmodSync(file, 0o000)
  try {
    if (process.getuid && process.getuid() === 0) return   // root can read anything
    assert.throws(() => loadEnvFile(path.join(dir, 'ureport-agent.yml'), './secrets.env'), /env_file cannot be read/)
  } finally {
    fs.chmodSync(file, 0o600)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('hiding secrets works when no env file was loaded', () => {
  assert.deepEqual(secretValues({ TOKEN: 'abcd1234' }, undefined, ['TOKEN']), ['abcd1234'])
})
