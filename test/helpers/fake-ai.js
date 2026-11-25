#!/usr/bin/env node
'use strict'
// Stand-in for the `claude` and `gemini` CLIs. Records the call and answers from $FAKE_AI, one response
// per call in order (the last one repeats): { responses: [{ stdout, stderr, code, delayMs }] }
const fs = require('fs')
const path = require('path')

const cmd = path.basename(process.argv[1])
const args = process.argv.slice(2)
if (process.env.FAKE_AI_LOG) {
  fs.appendFileSync(process.env.FAKE_AI_LOG, JSON.stringify({ cmd, cwd: process.cwd(), args, env: { STAGE_USER: process.env.STAGE_USER, STAGE_PASSWORD: process.env.STAGE_PASSWORD } }) + '\n')
}
const cfg = JSON.parse(process.env.FAKE_AI || '{}')
const dir = process.env.FAKE_STATE_DIR
const file = path.join(dir || '.', 'ai-count')
const n = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0
fs.writeFileSync(file, String(n + 1))
const responses = cfg.responses || [{ stdout: '{"analysis":"nothing to change","changes":[],"testPassed":true}' }]
const r = responses[Math.min(n, responses.length - 1)]
setTimeout(() => {
  if (r.stderr) process.stderr.write(r.stderr)
  if (r.stdout) process.stdout.write(r.stdout)
  process.exit(r.code || 0)
}, r.delayMs || 0)
