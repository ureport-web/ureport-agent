'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { startAgent, rerunJob } = require('./helpers/agent-harness')

let agent
test.afterEach(async () => { if (agent) await agent.stop(); agent = null })

const local = () => ({ mode: 'local', path: agent.repoPath })

test('runs the command in the local path and reports it passed with its output', async () => {
  agent = await startAgent()
  const res = await agent.runJob(rerunJob({ config: { command: 'echo hello; echo oops 1>&2', repo: local() } }))
  assert.equal(res.status, 'passed')
  assert.equal(res.exit_code, 0)
  assert.equal(res.command, 'echo hello; echo oops 1>&2')
  assert.match(res.output, /hello/)
  assert.match(res.output, /oops/)
  assert.equal((await agent.waitFor('rerun_running')).signal_id, 'rr-1')
})

test('a command that exits non-zero is a failed rerun with its exit code', async () => {
  agent = await startAgent()
  const res = await agent.runJob(rerunJob({ config: { command: 'echo broken; exit 3', repo: local() } }))
  assert.equal(res.status, 'failed')
  assert.equal(res.exit_code, 3)
  assert.match(res.output, /broken/)
})

test('a command that runs too long is stopped and reported as timed out', async () => {
  agent = await startAgent()
  const res = await agent.runJob(rerunJob({ config: { command: 'sleep 20', timeout_minutes: 1, repo: local() } }))
  assert.equal(res.status, 'timed_out')
  assert.equal(res.exit_code, -1)
})

test('the command gets the test fields and the environment lines of the config, ignoring blanks and comments', async () => {
  agent = await startAgent()
  const res = await agent.runJob(rerunJob({
    config: { command: 'echo "$GREETING {test.file} {test.name} {test.uid}"', env: '# a comment\n\nGREETING=hi there\nNOEQUALS\n=nokey', repo: local() },
    test: { file: 'tests/a.spec.ts', name: 'checkout works', uid: 'u-9' },
  }))
  assert.equal(res.status, 'passed')
  assert.equal(res.output, 'hi there tests/a.spec.ts checkout works u-9')
})

test('a missing timeout defaults to ten minutes and a missing test field is empty', async () => {
  agent = await startAgent()
  const res = await agent.runJob(rerunJob({ config: { command: 'echo "[{test.file}][{test.name}][{test.uid}]"', timeout_minutes: 0, repo: local() }, test: { file: '', name: '', uid: '' } }))
  assert.equal(res.output, '[][][]')
})

test('a command with substitution is blocked and never run', async () => {
  agent = await startAgent({ yml: { audit_log: 'audit.log' } })
  const res = await agent.runJob(rerunJob({ config: { command: 'echo $(whoami)', repo: local() } }))
  assert.equal(res.status, 'error')
  assert.equal(res.exit_code, -1)
  assert.match(res.output, /Command blocked by allowlist: command injection pattern/)
  const audit = fs.readFileSync(path.join(agent.dir, 'audit.log'), 'utf8')
  assert.match(audit, /"event":"command_blocked","stage":"rerun"/)
})

test('a command that is not on the allowed list is blocked', async () => {
  agent = await startAgent({ yml: { allowed_run_prefixes: ['npm test'] } })
  const res = await agent.runJob(rerunJob({ config: { command: 'rm -rf x', repo: local() } }))
  assert.match(res.output, /does not match any allowed prefix/)
})

test('a local path that does not exist is an error', async () => {
  agent = await startAgent()
  const res = await agent.runJob(rerunJob({ config: { repo: { mode: 'local', path: '/nonexistent/path' } } }))
  assert.equal(res.status, 'error')
  assert.match(res.output, /Local repo path not found: \/nonexistent\/path/)
  const none = await agent.runJob(rerunJob({ id: 'rr-2', config: { repo: { mode: 'local', path: null } } }))
  assert.match(none.output, /Local repo path not found/)
})

test('checkout mode clones on the first run, with the install command, and runs the command there', async () => {
  agent = await startAgent()
  const res = await agent.runJob(rerunJob({
    config: { command: 'echo ran', repo: { mode: 'checkout', remote: 'git@git.test:o/r.git', base_branch: 'dev', install_command: 'echo i > installed.txt' } },
    test: { uid: 'My Test/1' },
  }))
  assert.equal(res.status, 'passed')
  const lines = agent.gitCalls()
  assert.ok(lines.some((l) => l.startsWith('clone git@git.test:o/r.git') && l.includes('rerun__My-Test-1')))
  assert.ok(lines.includes('checkout dev'))
  assert.ok(lines.includes('reset --hard origin/dev'))
  assert.ok(fs.existsSync(path.join(agent.repoPath, 'rerun__My-Test-1', 'installed.txt')))
})

test('checkout mode reuses a repository it already has, and defaults the base branch to main', async () => {
  agent = await startAgent({ files: { 'rerun__u-1/.git/HEAD': 'ref' } })
  const res = await agent.runJob(rerunJob({ config: { repo: { mode: 'checkout', remote: 'git@git.test:o/r.git' } } }))
  assert.equal(res.status, 'passed')
  const lines = agent.gitCalls()
  assert.equal(lines.some((l) => l.startsWith('clone')), false)
  for (const expected of ['reset --hard HEAD', 'clean -fd', 'fetch origin', 'checkout main', 'reset --hard origin/main']) assert.ok(lines.includes(expected), expected)
})

test('checkout mode with a lane key in the command uses it for the folder name', async () => {
  agent = await startAgent()
  await agent.runJob(rerunJob({ config: { command: 'echo shop__ui', repo: { mode: 'checkout', remote: 'git@git.test:o/r.git' } } }))
  assert.ok(agent.gitCalls().some((l) => l.startsWith('clone') && l.includes('rerun__echo shop__ui')))
})

test('checkout mode falls back to the remote default branch, and fails when it cannot find one', async () => {
  agent = await startAgent({
    files: { 'rerun__u-1/.git/HEAD': 'ref' },
    git: { rules: [{ match: 'checkout main', code: 1, times: 1 }, { match: 'symbolic-ref', stdout: 'origin/trunk\n' }] },
  })
  const ok = await agent.runJob(rerunJob({ config: { repo: { mode: 'checkout', remote: 'git@git.test:o/r.git' } } }))
  assert.equal(ok.status, 'passed')
  assert.ok(agent.gitCalls().includes('checkout trunk'))
  await agent.stop()
  agent = await startAgent({ files: { 'rerun__u-1/.git/HEAD': 'ref' }, git: { rules: [{ match: 'checkout main', code: 1 }, { match: 'symbolic-ref', code: 1 }] } })
  const bad = await agent.runJob(rerunJob({ config: { repo: { mode: 'checkout', remote: 'git@git.test:o/r.git' } } }))
  assert.equal(bad.status, 'error')
  assert.match(bad.output, /Branch 'main' not found and could not detect remote default/)
})

test('checkout mode with no remote and no repository is an error', async () => {
  agent = await startAgent()
  const res = await agent.runJob(rerunJob({ config: { repo: { mode: 'checkout' } } }))
  assert.equal(res.status, 'error')
  assert.match(res.output, /repo.remote is not set in rerun config/)
})

test('a failing install command is an error', async () => {
  agent = await startAgent()
  const res = await agent.runJob(rerunJob({ config: { repo: { mode: 'checkout', remote: 'git@git.test:o/r.git', install_command: 'exit 4' } } }))
  assert.equal(res.status, 'error')
})
