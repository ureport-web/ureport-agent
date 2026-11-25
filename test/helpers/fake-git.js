#!/usr/bin/env node
'use strict'
// Stand-in for `git` on the agent's PATH. Records every call and answers from a script in $FAKE_GIT:
//   { rules: [{ match: 'rev-list --count', stdout: '0\n', code: 0, stderr: '', times: 1, after: 0 }] }
// A rule matches when the arguments start with `match`. `after` skips that many earlier matches and
// `times` limits how many it answers. Unmatched commands succeed with a sensible default.
const fs = require('fs')
const path = require('path')

const args = process.argv.slice(2)
const line = args.join(' ')
const cfg = JSON.parse(process.env.FAKE_GIT || '{}')
const dir = process.env.FAKE_STATE_DIR
if (process.env.FAKE_GIT_LOG) fs.appendFileSync(process.env.FAKE_GIT_LOG, JSON.stringify({ cwd: process.cwd(), args }) + '\n')

const DEFAULTS = [
  ['rev-parse --git-dir', '.git\n'],
  ['rev-parse --abbrev-ref HEAD', 'main\n'],
  ['rev-parse HEAD', 'abc1234\n'],
  ['status --porcelain', ' M tests/a.spec.ts\n'],
  ['rev-list --count', '1\n'],
  ['diff --cached', 'diff --git a/tests/a.spec.ts b/tests/a.spec.ts\n+fixed\n'],
  ['remote get-url origin', cfg.originUrl || 'git@git.test:owner/repo.git\n'],
  ['symbolic-ref --short refs/remotes/origin/HEAD', 'origin/main\n'],
]

function counter(name) {
  if (!dir) return 0
  const file = path.join(dir, name)
  const n = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0
  fs.writeFileSync(file, String(n + 1))
  return n
}

let hit = null
;(cfg.rules || []).forEach((rule, i) => {
  if (hit || !line.startsWith(rule.match)) return
  const seen = counter(`git-rule-${i}`)
  if (seen < (rule.after || 0)) return
  if (rule.times != null && seen - (rule.after || 0) >= rule.times) return
  hit = rule
})

const code = hit ? (hit.code || 0) : 0
if (code === 0 && args[0] === 'clone') fs.mkdirSync(path.join(args[2], '.git'), { recursive: true })
if (hit && hit.stderr) process.stderr.write(hit.stderr)
if (code !== 0) process.exit(code)
const out = hit && hit.stdout != null ? hit.stdout : (DEFAULTS.find(([m]) => line.startsWith(m)) || [null, ''])[1]
process.stdout.write(out)
