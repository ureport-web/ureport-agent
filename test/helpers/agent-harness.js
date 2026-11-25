'use strict'
// Runs the real agent as a child process against a fake UReport server (a WebSocket server), fake
// git / claude / gemini programs on its PATH and a fake pull request API. Nothing else is mocked, so
// these tests keep working however agent.js is organised inside.
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const crypto = require('crypto')
const { spawn } = require('child_process')
const { WebSocketServer } = require('ws')

const ROOT = path.resolve(__dirname, '..', '..')
const AGENT = path.join(ROOT, 'agent.js')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitUntil(check, { timeout = 8000, what = 'condition' } = {}) {
  const end = Date.now() + timeout
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(15)
  }
}

/** The signature the UReport server puts on a job. */
function sign(msg, secret) {
  return { ...msg, sig: crypto.createHmac('sha256', secret).update(JSON.stringify(msg)).digest('hex') }
}

/** A fake pull request API. `handler(req, body)` answers; every request is kept in `requests`. */
async function startPrApi(handler) {
  const requests = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => { raw += d })
    req.on('end', () => {
      let body = null
      try { body = raw ? JSON.parse(raw) : null } catch { body = raw }
      const record = { method: req.method, url: req.url, headers: req.headers, body }
      requests.push(record)
      const answer = handler(record) || { status: 404, body: {} }
      res.writeHead(answer.status || 200, { 'content-type': 'application/json' })
      res.end(answer.raw != null ? answer.raw : JSON.stringify(answer.body || {}))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }) }
}

/**
 * Starts the agent. Options:
 *   yml        extra keys for ureport-agent.yml (ureport_url and agent_token are filled in)
 *   rawYml     the whole file as text, instead (for invalid configs)
 *   noServer   do not start the fake server (for configs that make the agent exit)
 *   git, ai    scripts for the fake git and the fake AI CLIs (see fake-git.js / fake-ai.js)
 *   env        extra environment for the agent
 *   envFile    text of an env file; its path is set as env_file
 *   speed      timer speedup (default 100)
 *   files      { 'relative/path': 'content' } created under the workspace repo_path
 */
async function startAgent(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ureport-agent-test-'))
  const bin = path.join(dir, 'bin')
  const stateDir = path.join(dir, 'state')
  const repoPath = path.join(dir, 'workspace')
  fs.mkdirSync(bin); fs.mkdirSync(stateDir); fs.mkdirSync(repoPath)
  for (const [name, script] of [['git', 'fake-git.js'], ['claude', 'fake-ai.js'], ['gemini', 'fake-ai.js']]) {
    fs.copyFileSync(path.join(__dirname, script), path.join(bin, name))
    fs.chmodSync(path.join(bin, name), 0o755)
  }
  for (const [rel, content] of Object.entries(opts.files || {})) {
    const file = path.join(repoPath, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }

  // The fake UReport server
  const connections = []
  const received = []
  let server = null
  let port = 0
  if (!opts.noServer) {
    server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise((r) => server.on('listening', r))
    port = server.address().port
    server.on('connection', (ws, req) => {
      const conn = { ws, headers: req.headers, closedWith: null }
      connections.push(conn)
      ws.on('message', (data) => received.push(JSON.parse(data.toString())))
      ws.on('close', (code) => { conn.closedWith = code })
    })
  }

  const ymlPath = path.join(dir, 'ureport-agent.yml')
  let envFilePath = null
  if (opts.envFile != null) {
    envFilePath = path.join(dir, 'secrets.env')
    fs.writeFileSync(envFilePath, opts.envFile)
    fs.chmodSync(envFilePath, opts.envFileMode || 0o600)
  }
  const yamlText = opts.rawYml != null ? opts.rawYml : [
    `ureport_url: http://127.0.0.1:${port}`,
    'agent_token: agt_test_token',
    `repo_path: ${repoPath}`,
    ...(envFilePath ? [`env_file: ${envFilePath}`] : []),
    ...Object.entries(opts.yml || {}).map(([k, v]) => `${k}: ${JSON.stringify(v)}`),
  ].join('\n') + '\n'
  fs.writeFileSync(ymlPath, yamlText)

  const logs = { git: path.join(dir, 'git.log'), ai: path.join(dir, 'ai.log') }
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}`,
    FAKE_STATE_DIR: stateDir,
    FAKE_GIT: JSON.stringify(opts.git || {}),
    FAKE_GIT_LOG: logs.git,
    FAKE_AI: JSON.stringify(opts.ai || {}),
    FAKE_AI_LOG: logs.ai,
    AGENT_TEST_SPEED: String(opts.speed || 100),
    NODE_OPTIONS: `--require ${path.join(__dirname, 'speed.js')}`,
    ...(opts.env || {}),
  }
  for (const key of opts.unsetEnv || []) delete env[key]

  const configArg = opts.configArg === undefined ? [ymlPath] : (opts.configArg === null ? [] : [opts.configArg])
  const child = spawn(process.execPath, [AGENT, ...configArg], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => { stdout += d })
  child.stderr.on('data', (d) => { stderr += d })
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))

  const readLog = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
  const api = {
    dir, repoPath, ymlPath, envFilePath, child, exited, connections, received,
    get stdout() { return stdout },
    get stderr() { return stderr },
    get output() { return stdout + stderr },
    gitCalls: () => readLog(logs.git).map((c) => c.args.join(' ')),
    gitLog: () => readLog(logs.git),
    aiCalls: () => readLog(logs.ai),
    messagesOf: (type) => received.filter((m) => m.type === type),
    /** Resolves with the first message (after `from`) that matches. */
    waitFor: (match, { from = 0, timeout = 8000 } = {}) => waitUntil(
      () => received.slice(from).find(typeof match === 'string' ? (m) => m.type === match : match),
      { timeout, what: `agent message ${typeof match === 'string' ? match : '(matching)'}\n--- agent output ---\n${stdout}${stderr}` },
    ),
    waitForConnection: (n = 1) => waitUntil(() => connections.length >= n && connections[n - 1], { what: `connection #${n}\n${stdout}${stderr}` }),
    waitForOutput: (fragment, timeout = 8000) => waitUntil(() => (stdout + stderr).includes(fragment), { timeout, what: `output "${fragment}"\n${stdout}${stderr}` }),
    /** Sends a message from the fake server to the agent on its current connection. */
    send: async (msg) => { const conn = await api.waitForConnection(connections.length || 1); conn.ws.send(JSON.stringify(msg)) },
    sendRaw: async (text) => { const conn = await api.waitForConnection(connections.length || 1); conn.ws.send(text) },
    /** Sends a job and waits for the agent's final answer to it. */
    runJob: async (msg, { timeout = 15000 } = {}) => {
      const resultType = msg.type === 'rerun_job' ? 'rerun_result' : 'result'
      const from = received.length
      await api.send(msg)
      return api.waitFor((m) => m.type === resultType && m.signal_id === msg.signal_id, { from, timeout })
    },
    stop: async () => {
      // SIGTERM first: the agent exits through its own shutdown handler, which lets V8 write coverage data
      if (child.exitCode == null && child.signalCode == null) {
        child.kill('SIGTERM')
        const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
        await exited
        clearTimeout(timer)
      }
      await exited
      if (server) { for (const c of connections) { try { c.ws.terminate() } catch {} } await new Promise((r) => server.close(r)) }
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
  if (!opts.noServer && !opts.noWait) await api.waitForConnection(1)
  return api
}

const lane = { product: 'shop', type: 'ui' }
const baseTest = { id: 't1', uid: 'u-1', name: 'checkout works', file: 'tests/a.spec.ts', error_message: 'expected 1 to be 2', stack_trace: 'at a.spec.ts:10', steps: [] }

/** A heal job as the UReport server sends it. `pipeline` stages are merged over a minimal AI-fix-only pipeline. */
function healJob({ id = 'sig-00000001', pipeline = {}, playbook = {}, test = {}, context = {} } = {}) {
  const aiFix = { enabled: true, provider: 'claude-cli', instructions: 'Fix it', stepsBlock: 'STEPS', outputFormatBlock: 'FORMAT', previousAttemptHeader: 'PREV', previousAttemptAnalysis: 'PREV-ANALYSIS', previousAttemptOutput: 'PREV-OUTPUT', ...(pipeline.aiFix || {}) }
  return {
    type: 'heal_job',
    signal_id: id,
    playbook: {
      name: 'pb', requiredEnv: [],
      pipeline: { checkout: { enabled: false }, createPr: { enabled: false }, ...pipeline, aiFix: pipeline.aiFix === false ? { enabled: false } : aiFix },
      ...playbook,
    },
    job_context: { lane, test: { ...baseTest, ...test }, build_number: 7, triggered_by: 'user:admin', launches_path: '/launches?x=1', signal_id: id, ...context },
  }
}

function rerunJob({ id = 'rr-1', config = {}, test = {} } = {}) {
  return {
    type: 'rerun_job', signal_id: id,
    config: { command: 'echo ok', timeout_minutes: 10, env: '', repo: { mode: 'local', path: null }, ...config },
    test: { uid: 'u-1', name: 'checkout works', file: 'tests/a.spec.ts', ...test },
  }
}

const AI_FIXED = (extra = {}) => JSON.stringify({ analysis: 'the selector was wrong', changes: [{ file: 'tests/a.spec.ts', content: 'fixed' }], testPassed: true, testOutput: '1 passed', ...extra })

module.exports = { startAgent, startPrApi, healJob, rerunJob, sign, sleep, waitUntil, AI_FIXED }
