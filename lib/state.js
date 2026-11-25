'use strict'

// What the running agent shares between its parts: the config, the connection, the job that is running
// and the environment of that job. One object, so every part sees the same values.
const state = {
  cfg: null,              // set at startup; used by the audit log
  ws: null,
  reconnectTimer: null,
  stopping: false,
  currentJob: null,       // signal_id of the running job; null if idle
  // Environment of the running job (one at a time): the agent's own plus the env-file variables its
  // playbook declares. `secrets` are the values to hide from everything the agent reports.
  jobEnv: null,
  jobEnvNames: [],
  secrets: [],
}

module.exports = state
