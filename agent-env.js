'use strict'

/**
 * Environment variables a job needs: an optional env file, the names a playbook declares, and the
 * check that they are all there. Values never leave the agent: they are not sent to the server, not
 * put in the prompt, and are masked in everything the agent reports.
 */

const fs   = require('fs')
const path = require('path')

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
/** Shorter values are not masked: they would blank out ordinary words in the output. */
const MIN_MASKED_LENGTH = 4

/**
 * KEY=VALUE per line. Blank lines and lines starting with # are skipped; the value is everything after
 * the first `=`, with one pair of surrounding quotes removed. No `export` prefix, no expansion.
 */
function parseEnvFile(text) {
  const vars = {}
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf('=')
    if (idx <= 0) continue
    const name = trimmed.slice(0, idx).trim()
    if (!ENV_NAME_RE.test(name)) continue
    let value = trimmed.slice(idx + 1).trim()
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) {
      value = value.slice(1, -1)
    }
    vars[name] = value
  }
  return vars
}

/**
 * Reads the env file named in the config. The path is relative to the config file. Throws when it is
 * set but cannot be read, so a typo stops the agent at startup instead of failing a heal later.
 * Returns { path, vars, loose } where `loose` says group or others can read the file.
 */
function loadEnvFile(configPath, envFile) {
  if (!envFile) return { path: null, vars: {}, loose: false }
  const file = path.resolve(path.dirname(configPath), String(envFile).trim())
  let stat
  try {
    stat = fs.statSync(file)
  } catch (err) {
    throw new Error(`env_file not found: ${file}`)
  }
  if (!stat.isFile()) throw new Error(`env_file is not a file: ${file}`)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    throw new Error(`env_file cannot be read: ${file} (${err.message})`)
  }
  return { path: file, vars: parseEnvFile(text), loose: process.platform !== 'win32' && (stat.mode & 0o077) !== 0 }
}

/** The variable names a playbook declares, valid ones only, without duplicates. */
function declaredNames(playbook) {
  const raw = Array.isArray(playbook?.requiredEnv) ? playbook.requiredEnv : []
  return [...new Set(raw.map((n) => String(n).trim()).filter((n) => ENV_NAME_RE.test(n)))]
}

/**
 * The environment of one job: the agent's own, plus the env-file variables the playbook declares. A
 * variable already set in the agent's shell wins over the file. Variables of the file that the playbook
 * does not declare are left out, so a job only ever sees what its playbook asked for.
 * `missing` lists declared names that have no value anywhere.
 */
function buildJobEnv(baseEnv, fileVars, names) {
  const env = { ...baseEnv }
  const missing = []
  for (const name of names) {
    const fromShell = baseEnv[name]
    if (fromShell !== undefined && fromShell !== '') continue
    if (fileVars[name] !== undefined && fileVars[name] !== '') env[name] = fileVars[name]
    else missing.push(name)
  }
  return { env, missing }
}

/** The values to hide: those of the declared variables, plus the env file's, as the text and as JSON. */
function secretValues(env, fileVars, names) {
  const values = new Set()
  const add = (v) => {
    if (typeof v !== 'string' || v.length < MIN_MASKED_LENGTH) return
    values.add(v)
    values.add(JSON.stringify(v).slice(1, -1))
  }
  names.forEach((n) => add(env[n]))
  Object.values(fileVars || {}).forEach(add)
  return [...values].sort((a, b) => b.length - a.length)
}

function maskSecrets(text, values) {
  let out = text
  for (const v of values) out = out.split(v).join('***')
  return out
}

/**
 * The startup heads-up when an env file was loaded: where it came from, which variable names it holds
 * (never the values), which of them the shell overrides, and a warning when other users can read it.
 * Returns [{ level: 'info' | 'warn', text }]; nothing when no env file is configured.
 */
function envFileNotice(envFile, baseEnv) {
  if (!envFile || !envFile.path) return []
  const names = Object.keys(envFile.vars)
  const lines = []
  if (names.length === 0) {
    lines.push({ level: 'info', text: `env_file ${envFile.path} is set but has no variables` })
  } else {
    lines.push({ level: 'info', text: `NOTE: ${names.length} environment variable(s) loaded from file ${envFile.path}: ${names.join(', ')}` })
    const overridden = names.filter((n) => baseEnv[n] !== undefined && baseEnv[n] !== '')
    if (overridden.length > 0) lines.push({ level: 'info', text: `already set in the shell, so the shell value is used: ${overridden.join(', ')}` })
    lines.push({ level: 'info', text: 'a job only gets the variables its playbook lists; values are masked in everything reported' })
  }
  if (envFile.loose) lines.push({ level: 'warn', text: `WARNING: ${envFile.path} is readable by other users — run: chmod 600 ${envFile.path}` })
  return lines
}

module.exports = { ENV_NAME_RE, parseEnvFile, loadEnvFile, declaredNames, buildJobEnv, secretValues, maskSecrets, envFileNotice }
