'use strict'

// Everything the agent tells the server: progress, results, and the audit log.

const fs = require('fs')
const WebSocket = require('ws')
const agentEnv = require('../agent-env')
const state = require('./state')
const { endJobEnv } = require('./job-env')

/**
 * Write an entry to the audit log if configured.
 * Each line is a JSON object: { ts, ...fields }
 */
function writeAuditLog(cfg, fields) {
  if (!cfg.audit_log) return
  try {
    const line = agentEnv.maskSecrets(JSON.stringify({ ts: new Date().toISOString(), ...fields }), state.secrets) + '\n'
    fs.appendFileSync(cfg.audit_log, line)
  } catch (e) {
    console.warn('[agent] audit log write failed:', e.message)
  }
}

function send(msg) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(agentEnv.maskSecrets(JSON.stringify(msg), state.secrets))
  }
}

function sendProgress(signalId, stepIndex, stepId, status, message, output) {
  send({ type: 'progress', signal_id: signalId, step_index: stepIndex, step_id: stepId, status, message, output: output || null })
}

function sendResult(signalId, outcome) {
  send({ type: 'result', signal_id: signalId, ...outcome })
  writeAuditLog(state.cfg, { event: 'job_result', type: 'heal_job', signal_id: signalId, status: outcome.status })
  state.currentJob = null
  endJobEnv()
}

function sendRerunResult(signalId, outcome) {
  send({ type: 'rerun_result', signal_id: signalId, ...outcome })
  writeAuditLog(state.cfg, { event: 'job_result', type: 'rerun_job', signal_id: signalId, status: outcome.status })
  state.currentJob = null
}

module.exports = { writeAuditLog, send, sendProgress, sendResult, sendRerunResult }
