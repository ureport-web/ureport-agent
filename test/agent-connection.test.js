'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { startAgent, healJob, rerunJob, sign, sleep } = require('./helpers/agent-harness')

let agent
test.afterEach(async () => { if (agent) await agent.stop(); agent = null })

test('connects with the token, says hello with its version and job types, and registers', async () => {
  agent = await startAgent()
  const conn = agent.connections[0]
  assert.equal(conn.headers.authorization, 'Bearer agt_test_token')
  const hello = await agent.waitFor('hello')
  assert.equal(hello.version, require('../package.json').version)
  assert.deepEqual(hello.job_types, ['heal', 'rerun'])
  await agent.send({ type: 'registered', agent_name: 'a1' })
  await agent.waitForOutput('registered as: a1')
})

test('the server address may use https and a trailing slash', async () => {
  agent = await startAgent({ rawYml: 'ureport_url: https://127.0.0.1:1/\nagent_token: t\n', noServer: true })
  await agent.waitForOutput('connecting to wss://127.0.0.1:1/ws/agent')
})

test('answers a ping with a pong, and ignores unknown or unreadable messages', async () => {
  agent = await startAgent()
  await agent.send({ type: 'ping' })
  await agent.waitFor('pong')
  await agent.send({ type: 'something-new' })
  await agent.sendRaw('not json')
  await agent.waitForOutput('unparseable message')
})

test('reconnects after the server closes the connection', async () => {
  agent = await startAgent()
  agent.connections[0].ws.close(1012)
  await agent.waitForOutput('disconnected (code=1012')
  await agent.waitForConnection(2)
  assert.equal(agent.messagesOf('hello').length >= 2, true)
})

test('keeps the connection alive with pings', async () => {
  agent = await startAgent({ speed: 1000 })
  const conn = agent.connections[0]
  const pinged = new Promise((resolve) => conn.ws.once('ping', resolve))
  await pinged
})

test('stops cleanly on SIGTERM', async () => {
  agent = await startAgent()
  agent.child.kill('SIGTERM')
  const { code } = await agent.exited
  assert.equal(code, 0)
  assert.match(agent.output, /shutting down/)
})

test('an error on the socket is logged, not fatal', async () => {
  agent = await startAgent()
  agent.connections[0].ws._socket.write(Buffer.from([0x8f, 0x00]))
  await agent.waitForOutput('WS error')
})

test('the first connect failing is retried', async () => {
  agent = await startAgent({ rawYml: 'ureport_url: http://127.0.0.1:1\nagent_token: t\n', noServer: true })
  await agent.waitForOutput('WS error')
  await agent.waitForOutput('reconnecting in 5s')
})

test('a job type that is not accepted is refused with a result the server can show', async () => {
  agent = await startAgent({ yml: { accept_job_types: ['rerun'] } })
  const heal = await agent.runJob(healJob())
  assert.equal(heal.status, 'error')
  assert.match(heal.error_detail, /'heal' is not in accept_job_types/)
  agent.stop; await agent.stop(); agent = await startAgent({ yml: { accept_job_types: ['heal'] } })
  const rerun = await agent.runJob(rerunJob())
  assert.equal(rerun.status, 'error')
  assert.equal(rerun.exit_code, -1)
  assert.match(rerun.output, /'rerun' is not in accept_job_types/)
})

test('with a signing secret a job needs a valid signature', async () => {
  agent = await startAgent({ yml: { signing_secret: 's3cret' } })
  const unsigned = await agent.runJob(healJob({ id: 'sig-unsigned' }))
  assert.match(unsigned.error_detail, /invalid signature/)
  const wrong = await agent.runJob({ ...sign(healJob({ id: 'sig-wrong' }), 'other-secret') })
  assert.match(wrong.error_detail, /invalid signature/)
  const tampered = sign(healJob({ id: 'sig-tampered' }), 's3cret')
  tampered.signal_id = 'sig-tampered2'
  const res = await agent.runJob(tampered)
  assert.match(res.error_detail, /invalid signature/)
  const rerunUnsigned = await agent.runJob(rerunJob({ id: 'rr-unsigned' }))
  assert.match(rerunUnsigned.output, /invalid signature/)
  const good = await agent.runJob(sign(healJob({ id: 'sig-good', pipeline: {} }), 's3cret'))
  assert.notEqual(good.error_detail && /invalid signature/.test(good.error_detail), true)
})

test('a malformed signature is refused, not a crash', async () => {
  agent = await startAgent({ yml: { signing_secret: 's3cret' } })
  const msg = { ...healJob({ id: 'sig-bad-hex' }), sig: 'zz' }
  const res = await agent.runJob(msg)
  assert.match(res.error_detail, /invalid signature/)
})

test('a second job while one is running is ignored', async () => {
  agent = await startAgent({ ai: { responses: [{ stdout: '{"analysis":"a","changes":[],"testPassed":true}', delayMs: 600 }] } })
  const first = agent.runJob(healJob({ id: 'sig-first' }))
  await agent.waitFor((m) => m.type === 'progress' && m.signal_id === 'sig-first')
  await agent.send(healJob({ id: 'sig-second' }))
  await agent.send(rerunJob({ id: 'rr-second' }))
  await first
  await agent.waitForOutput('already running job sig-first — ignoring new job sig-second')
  await agent.waitForOutput('ignoring rerun job rr-second')
  assert.equal(agent.received.some((m) => m.signal_id === 'sig-second'), false)
})

test('a playbook with no pipeline is reported as an error', async () => {
  agent = await startAgent()
  const res = await agent.runJob(healJob({ playbook: { pipeline: undefined } }))
  assert.equal(res.status, 'error')
  assert.match(res.error_detail, /pipeline|undefined/i)
})

test('a job with no playbook at all is reported as an error, not a crash', async () => {
  agent = await startAgent()
  const res = await agent.runJob({ type: 'heal_job', signal_id: 'sig-broken', job_context: {} })
  assert.equal(res.status, 'error')
})
