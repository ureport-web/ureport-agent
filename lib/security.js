'use strict'

// Checks on what the server sends: the signature of a job and the commands the agent may run.

const crypto = require('crypto')

/**
 * Verify HMAC-SHA256 signature on an incoming job message.
 * Returns true if: signing_secret not configured, or signature matches.
 * Returns false if: signing_secret configured but sig missing or wrong.
 */
function verifyPayloadSig(msg, signingSecret) {
  if (!signingSecret) return true
  const { sig, ...payload } = msg
  if (!sig) return false
  const expected = crypto.createHmac('sha256', signingSecret)
    .update(JSON.stringify(payload))
    .digest('hex')
  try {
    return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))
  } catch {
    return false
  }
}

/**
 * Check a shell command against the security allowlist.
 * Always blocks backtick and $( command substitution.
 * If allowed_run_prefixes configured, command must start with one of them.
 * Returns { ok: true } or { ok: false, reason: string }.
 */
const COMMAND_INJECTION_RE = /`|\$\(|\x00/

function checkCommandAllowlist(cmd, cfg) {
  if (COMMAND_INJECTION_RE.test(cmd)) {
    return { ok: false, reason: `command injection pattern in: ${cmd}` }
  }
  if (cfg.allowed_run_prefixes && cfg.allowed_run_prefixes.length > 0) {
    const allowed = cfg.allowed_run_prefixes.some(prefix => cmd.startsWith(prefix))
    if (!allowed) {
      return { ok: false, reason: `command does not match any allowed prefix. Got: ${cmd}` }
    }
  }
  return { ok: true }
}

module.exports = { verifyPayloadSig, checkCommandAllowlist }
