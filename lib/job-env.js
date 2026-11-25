'use strict'

// The environment of the job that is running: the agent's own plus the variables its playbook declares.

const agentEnv = require('../agent-env')
const state = require('./state')

/** Environment for the AI CLI and install commands. */
function jobEnv() {
  return state.jobEnv || process.env
}

/** Sets the job's environment. Returns the declared variable names that have no value anywhere. */
function beginJobEnv(cfg, playbook) {
  const names = agentEnv.declaredNames(playbook)
  const { env, missing } = agentEnv.buildJobEnv(process.env, cfg.env_file_vars || {}, names)
  state.jobEnv = env
  state.jobEnvNames = names
  state.secrets = agentEnv.secretValues(env, cfg.env_file_vars, names)
  return missing
}

function endJobEnv() {
  state.jobEnv = null
  state.jobEnvNames = []
  state.secrets = []
}

module.exports = { jobEnv, beginJobEnv, endJobEnv }
