'use strict'

// Runs a program and collects its output, with an optional timeout.

const { spawn } = require('child_process')

function exec(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env || process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    let timedOut = false
    const timer = opts.timeout ? setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, opts.timeout) : null
    child.on('close', code => {
      if (timer) clearTimeout(timer)
      if (timedOut) { const e = new Error(`timed out: ${cmd} ${args.join(' ')}`); e.output = stdout + stderr; e.exitCode = -1; return reject(e) }
      if (code !== 0) { const e = new Error(`exit ${code}: ${cmd} ${args.join(' ')}\n${stderr || stdout}`); e.output = (stdout + stderr).trim(); e.exitCode = code; return reject(e) }
      resolve({ stdout, stderr })
    })
    child.on('error', reject)
  })
}

module.exports = { exec }
