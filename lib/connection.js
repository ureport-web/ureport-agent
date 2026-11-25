'use strict'

// The WebSocket connection to the server: connect, reconnect, heartbeat and the messages it sends.

const WebSocket = require('ws')
const VERSION = require('../package.json').version
const state = require('./state')
const { runJob } = require('./pipeline')
const { send, sendRerunResult, sendResult, writeAuditLog } = require('./reporting')
const { runRerunJob } = require('./rerun')
const { verifyPayloadSig } = require('./security')

const RECONNECT_DELAY_MS   = 5_000

const HEARTBEAT_INTERVAL_MS = 30_000

function wsUrl(cfg) {
  return cfg.ureport_url.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://') + '/ws/agent'
}

function connect(cfg) {
  if (state.stopping) return
  const url = wsUrl(cfg)
  console.log(`[agent] connecting to ${url}`)

  state.ws = new WebSocket(url, { headers: { Authorization: `Bearer ${cfg.agent_token}` } })

  state.ws.on('open', () => {
    console.log('[agent] connected')
    state.currentJob = null  // reset — any mid-flight job from previous connection is orphaned

    send({ type: 'hello', version: VERSION, active_lanes: [], job_types: cfg.accept_job_types })

    const hb = setInterval(() => {
      if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.ping()
      else clearInterval(hb)
    }, HEARTBEAT_INTERVAL_MS)
    state.ws._hbTimer = hb
  })

  state.ws.on('message', (data) => {
    let msg
    try { msg = JSON.parse(data.toString()) }
    catch { console.warn('[agent] unparseable message'); return }

    handleMessage(msg, cfg)
  })

  state.ws.on('pong', () => { /* heartbeat ack */ })

  state.ws.on('close', (code, reason) => {
    console.warn(`[agent] disconnected (code=${code} reason=${reason || 'none'})`)
    if (state.ws._hbTimer) clearInterval(state.ws._hbTimer)
    scheduleReconnect(cfg)
  })

  state.ws.on('error', (err) => {
    console.error('[agent] WS error:', err.message)
  })
}

function scheduleReconnect(cfg) {
  if (state.stopping || state.reconnectTimer) return
  console.log(`[agent] reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`)
  state.reconnectTimer = setTimeout(() => { state.reconnectTimer = null; connect(cfg) }, RECONNECT_DELAY_MS)
}

// Tell the server a job was refused, so its signal ends in "error" instead of staying "queued".
// Unlike sendResult/sendRerunResult this leaves state.currentJob alone: another job may be running.
function rejectJob(msg, cfg, reason, detail) {
  writeAuditLog(cfg, { event: 'job_rejected', reason, signal_id: msg.signal_id })
  if (msg.type === 'rerun_job') {
    send({ type: 'rerun_result', signal_id: msg.signal_id, status: 'error', output: detail, exit_code: -1 })
  } else {
    send({ type: 'result', signal_id: msg.signal_id, status: 'error', error_detail: detail, steps_completed: 0, step_outputs: {} })
  }
}

const SIGNATURE_REJECTED_DETAIL = 'Agent rejected the job: invalid signature. Check that signing_secret in the agent config matches HEAL_SIGNING_SECRET on the server.'

function handleMessage(msg, cfg) {
  switch (msg.type) {
    case 'registered':
      console.log(`[agent] registered as: ${msg.agent_name}`)
      break

    case 'heal_job': {
      if (!verifyPayloadSig(msg, cfg.signing_secret)) {
        console.error(`[agent] heal_job REJECTED — invalid signature for signal=${msg.signal_id}`)
        rejectJob(msg, cfg, 'invalid_signature', SIGNATURE_REJECTED_DETAIL)
        return
      }
      if (!cfg.accept_job_types.includes('heal')) {
        console.warn(`[agent] heal_job ignored — 'heal' not in accept_job_types`)
        rejectJob(msg, cfg, 'job_type_not_accepted', "Agent rejected the job: 'heal' is not in accept_job_types in the agent config.")
        return
      }
      writeAuditLog(cfg, { event: 'job_received', type: 'heal_job', signal_id: msg.signal_id })
      if (state.currentJob) {
        console.warn(`[agent] already running job ${state.currentJob} — ignoring new job ${msg.signal_id}`)
        return
      }
      state.currentJob = msg.signal_id
      console.log(`[agent] job received: signal=${msg.signal_id}`)
      runJob(msg, cfg).catch(err => {
        console.error('[agent] unhandled job error:', err.message)
        sendResult(msg.signal_id, { status: 'error', error_detail: err.message, steps_completed: 0, step_outputs: {} })
      })
      break
    }

    case 'rerun_job': {
      if (!verifyPayloadSig(msg, cfg.signing_secret)) {
        console.error(`[agent] rerun_job REJECTED — invalid signature for signal=${msg.signal_id}`)
        rejectJob(msg, cfg, 'invalid_signature', SIGNATURE_REJECTED_DETAIL)
        return
      }
      if (!cfg.accept_job_types.includes('rerun')) {
        console.warn(`[agent] rerun_job ignored — 'rerun' not in accept_job_types`)
        rejectJob(msg, cfg, 'job_type_not_accepted', "Agent rejected the job: 'rerun' is not in accept_job_types in the agent config.")
        return
      }
      writeAuditLog(cfg, { event: 'job_received', type: 'rerun_job', signal_id: msg.signal_id })
      if (state.currentJob) {
        console.warn(`[agent] already running job ${state.currentJob} — ignoring rerun job ${msg.signal_id}`)
        return
      }
      state.currentJob = msg.signal_id
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

module.exports = { connect }
