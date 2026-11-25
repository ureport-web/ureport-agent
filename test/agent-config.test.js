'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { startAgent, healJob, rerunJob } = require('./helpers/agent-harness')

let agent
test.afterEach(async () => { if (agent) await agent.stop(); agent = null })

const refuses = async (opts, fragment) => {
  agent = await startAgent({ noServer: true, ...opts })
  const { code } = await agent.exited
  assert.equal(code, 1)
  assert.ok(agent.output.includes(fragment), `expected "${fragment}" in:\n${agent.output}`)
}

test('exits when the config file does not exist', async () => {
  await refuses({ configArg: path.join('/nonexistent', 'ureport-agent.yml') }, 'config not found')
})

test('without a path argument it reads ureport-agent.yml from the working directory', async () => {
  agent = await startAgent({ configArg: null, noServer: false })
  await agent.waitFor('hello')
  fs.copyFileSync(agent.ymlPath, path.join(agent.dir, 'ureport-agent.yml.bak'))
})

test('exits when the server address or the token is missing', async () => {
  await refuses({ rawYml: 'agent_token: abc\n' }, 'ureport_url and agent_token are required')
  await agent.stop(); agent = null
  await refuses({ rawYml: 'ureport_url: http://x\n' }, 'ureport_url and agent_token are required')
})

test('exits when the token is still the placeholder', async () => {
  await refuses({ rawYml: 'ureport_url: http://x\nagent_token: PASTE_YOUR_TOKEN_HERE\n' }, 'replace PASTE_YOUR_TOKEN_HERE')
})

test('exits when env_file points to a file that does not exist', async () => {
  await refuses({ rawYml: 'ureport_url: http://x\nagent_token: t\nenv_file: ./missing.env\n' }, 'env_file not found')
})

test('exits when git_hosts names an unsupported provider', async () => {
  await refuses({ rawYml: 'ureport_url: http://x\nagent_token: t\ngit_hosts:\n  git.corp.com:\n    provider: svn\n' }, 'provider must be one of')
})

test('reads an env file, says which variables it found without their values, and warns when it is readable by others', async () => {
  agent = await startAgent({ envFile: 'STAGE_USER=qa-bot\nSTAGE_PASSWORD=hunter22\n', envFileMode: 0o644 })
  await agent.waitFor('hello')
  assert.match(agent.output, /loaded from file .*secrets\.env/)
  assert.match(agent.output, /STAGE_USER, STAGE_PASSWORD/)
  assert.match(agent.output, /readable by other users/)
  assert.doesNotMatch(agent.output, /hunter22/)
})

test('takes the settings as written: prefixes as a list or a single value, job types, timeouts, signing secret', async () => {
  agent = await startAgent({
    yml: { allowed_run_prefixes: 'echo', accept_job_types: ['rerun'], claude_cli_timeout_minutes: 5, gemini_cli_timeout_minutes: 6, signing_secret: '  s  ', audit_log: 'audit.log', ai_model: 'x' },
  })
  const hello = await agent.waitFor('hello')
  assert.deepEqual(hello.job_types, ['rerun'])
  const blocked = await agent.runJob(rerunJob({ config: { command: 'ls', repo: { mode: 'local', path: agent.repoPath } } }))
  assert.equal(blocked.status, 'error')
})

test('a list of allowed prefixes lets a matching command through', async () => {
  agent = await startAgent({ yml: { allowed_run_prefixes: ['echo', '  ', 'printf'] } })
  const ok = await agent.runJob(rerunJob({ config: { command: 'echo hi', repo: { mode: 'local', path: agent.repoPath } }, id: 'rr-ok' }))
  assert.equal(ok.status, 'passed')
  const no = await agent.runJob(rerunJob({ config: { command: 'ls', repo: { mode: 'local', path: agent.repoPath } }, id: 'rr-no' }))
  assert.match(no.output, /does not match any allowed prefix/)
})

test('without a repo_path the workspace is a folder next to where the agent runs', async () => {
  agent = await startAgent({ rawYml: 'ureport_url: http://127.0.0.1:1\nagent_token: t\n', noServer: true })
  await agent.waitForOutput(`workspace: ${path.join(fs.realpathSync(agent.dir), 'workspace')}`)
})

test('the audit log records jobs received, rejected, blocked and finished, with secrets hidden', async () => {
  agent = await startAgent({
    yml: { audit_log: 'audit.log', signing_secret: 'top', allowed_run_prefixes: ['echo'] },
    envFile: 'STAGE_PASSWORD=hunter22\n',
  })
  await agent.runJob(healJob({ id: 'sig-rejected' }))                    // no signature
  await agent.runJob(rerunJob({ id: 'rr-blocked', config: { command: 'ls', repo: { mode: 'local', path: agent.repoPath } } }))
  const log = fs.readFileSync(path.join(agent.dir, 'audit.log'), 'utf8')
  assert.match(log, /"event":"job_rejected"/)
  assert.doesNotMatch(log, /hunter22/)
})

test('an audit log that cannot be written is a warning, not a failure', async () => {
  agent = await startAgent({ yml: { audit_log: '/nonexistent-dir/audit.log' } })
  await agent.runJob(healJob({ id: 'sig-x', playbook: { pipeline: undefined } }))
  await agent.waitForOutput('audit log write failed')
})
