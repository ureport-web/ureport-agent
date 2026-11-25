'use strict'
// Preloaded into the agent under test: runs its long timers (reconnect, heartbeat, command timeouts)
// AGENT_TEST_SPEED times faster, so tests do not wait for them.
const speed = Number(process.env.AGENT_TEST_SPEED || 1)
if (speed > 1) {
  for (const name of ['setTimeout', 'setInterval']) {
    const original = global[name]
    global[name] = (fn, ms, ...rest) => original(fn, ms >= 1000 ? Math.max(1, Math.floor(ms / speed)) : ms, ...rest)
  }
}
