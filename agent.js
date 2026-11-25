#!/usr/bin/env node
'use strict'

// ureport-agent: connects to the UReport server and runs the jobs it sends (heal jobs and reruns) on this machine.
//   lib/config.js       reads ureport-agent.yml          lib/connection.js  the WebSocket and the messages
//   lib/pipeline.js     one heal job, stage by stage     lib/rerun.js       one rerun job
//   lib/checkout.js, lib/ai-fix.js, lib/create-pr.js     the stages of a heal job
//   lib/security.js, lib/job-env.js, lib/reporting.js    signatures and allow-list, job environment, what is reported

const VERSION = require('./package.json').version
const state = require('./lib/state')
const { loadConfig } = require('./lib/config')
const { connect } = require('./lib/connection')

function shutdown() {
  console.log('[agent] shutting down...')
  state.stopping = true
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer)
  if (state.ws) { if (state.ws._hbTimer) clearInterval(state.ws._hbTimer); state.ws.close(1000, 'agent shutdown') }
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

const cfg = loadConfig()
state.cfg = cfg
console.log(`[agent] ureport-agent v${VERSION}`)
console.log(`[agent] server:    ${cfg.ureport_url}`)
console.log(`[agent] workspace: ${cfg.repo_path}`)
connect(cfg)
