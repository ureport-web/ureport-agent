'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { parseEnvFile, loadEnvFile, declaredNames, buildJobEnv, secretValues, maskSecrets, envFileNotice } = require('../agent-env')

test('parseEnvFile reads KEY=VALUE lines, skips comments and blanks, keeps = inside values', () => {
  const vars = parseEnvFile('# comment\n\nA=1\nB = two words \nC=x=y=z\r\nD="quoted value"\nE=\'single\'\nnot a line\n1BAD=no\n=nokey\n')
  assert.deepEqual(vars, { A: '1', B: 'two words', C: 'x=y=z', D: 'quoted value', E: 'single' })
})

test('parseEnvFile keeps an unbalanced quote as it is', () => {
  assert.equal(parseEnvFile('A="open').A, '"open')
})

test('loadEnvFile resolves the path against the config file and flags a loose mode', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-env-'))
  const file = path.join(dir, 'secrets.env')
  fs.writeFileSync(file, 'TOKEN=abc12345\n')
  fs.chmodSync(file, 0o600)
  const strict = loadEnvFile(path.join(dir, 'ureport-agent.yml'), './secrets.env')
  assert.deepEqual(strict.vars, { TOKEN: 'abc12345' })
  assert.equal(strict.path, file)
  assert.equal(strict.loose, false)
  fs.chmodSync(file, 0o644)
  assert.equal(loadEnvFile(path.join(dir, 'ureport-agent.yml'), 'secrets.env').loose, process.platform !== 'win32')
})

test('loadEnvFile without a setting loads nothing, and a missing file throws', () => {
  assert.deepEqual(loadEnvFile('/x/ureport-agent.yml', undefined).vars, {})
  assert.throws(() => loadEnvFile('/x/ureport-agent.yml', './nope.env'), /env_file not found/)
  assert.throws(() => loadEnvFile(os.tmpdir() + '/ureport-agent.yml', '.'), /not a file/)
})

test('declaredNames keeps valid names once and drops the rest', () => {
  assert.deepEqual(declaredNames({ requiredEnv: ['A', ' B ', 'A', 'bad-name', '1X', '', 7] }), ['A', 'B'])
  assert.deepEqual(declaredNames({}), [])
  assert.deepEqual(declaredNames({ requiredEnv: 'A' }), [])
})

test('buildJobEnv gives a job only the file variables its playbook declares', () => {
  const { env, missing } = buildJobEnv({ PATH: '/bin' }, { USER_NAME: 'bot', OTHER: 'hidden' }, ['USER_NAME'])
  assert.equal(env.USER_NAME, 'bot')
  assert.equal(env.OTHER, undefined)
  assert.equal(env.PATH, '/bin')
  assert.deepEqual(missing, [])
})

test('buildJobEnv lets the shell win over the file', () => {
  const { env, missing } = buildJobEnv({ TOKEN: 'from-shell' }, { TOKEN: 'from-file' }, ['TOKEN'])
  assert.equal(env.TOKEN, 'from-shell')
  assert.deepEqual(missing, [])
})

test('buildJobEnv reports a declared name that has no value, empty ones included', () => {
  const { missing } = buildJobEnv({ EMPTY: '' }, { BLANK: '' }, ['NOPE', 'EMPTY', 'BLANK'])
  assert.deepEqual(missing, ['NOPE', 'EMPTY', 'BLANK'])
})

test('buildJobEnv does not change the base environment', () => {
  const base = { A: '1' }
  buildJobEnv(base, { B: '2' }, ['B'])
  assert.deepEqual(base, { A: '1' })
})

test('maskSecrets hides values in plain and JSON-escaped form, longest first, and spares short ones', () => {
  const values = secretValues({ PW: 'p"ss word1', SHORT: 'ab' }, { OTHER: 'token-1234' }, ['PW', 'SHORT'])
  const msg = JSON.stringify({ out: 'login p"ss word1 then token-1234 and ab' })
  const masked = maskSecrets(msg, values)
  assert.ok(!masked.includes('word1'))
  assert.ok(!masked.includes('token-1234'))
  assert.ok(masked.includes(' ab'))
  assert.deepEqual(JSON.parse(masked), { out: 'login *** then *** and ab' })
})

test('maskSecrets with nothing to hide returns the text as it is', () => {
  assert.equal(maskSecrets('hello', []), 'hello')
})

test('envFileNotice names the loaded variables, the ones the shell overrides, and never the values', () => {
  const file = { path: '/a/ureport-agent.env', vars: { STAGE_USER: 'qa-bot', STAGE_PASSWORD: 'secret-pass' }, loose: false }
  const lines = envFileNotice(file, { STAGE_USER: 'from-shell' })
  const text = lines.map((l) => l.text).join('\n')
  assert.match(text, /2 environment variable\(s\) loaded from file \/a\/ureport-agent\.env: STAGE_USER, STAGE_PASSWORD/)
  assert.match(text, /shell value is used: STAGE_USER$/m)
  assert.doesNotMatch(text, /qa-bot|secret-pass|from-shell/)
  assert.ok(lines.every((l) => l.level === 'info'))
})

test('envFileNotice warns about a readable file, reports an empty file, and is silent without a file', () => {
  const loose = envFileNotice({ path: '/a/x.env', vars: { A: '1' }, loose: true }, {})
  assert.deepEqual(loose.filter((l) => l.level === 'warn').map((l) => l.text), ['WARNING: /a/x.env is readable by other users — run: chmod 600 /a/x.env'])
  assert.match(envFileNotice({ path: '/a/x.env', vars: {}, loose: false }, {})[0].text, /has no variables/)
  assert.deepEqual(envFileNotice({ path: null, vars: {}, loose: false }, {}), [])
})
