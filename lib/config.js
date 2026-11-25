'use strict'

// Reads ureport-agent.yml.

const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')
const agentEnv = require('../agent-env')
const { normalizeGitHosts } = require('../git-providers')

function loadConfig() {
  const configPath = process.argv[2] || path.resolve(process.cwd(), 'ureport-agent.yml')
  if (!fs.existsSync(configPath)) {
    console.error(`[agent] config not found: ${configPath}`)
    console.error('[agent] copy ureport-agent.yml.example to ureport-agent.yml and fill in your values')
    process.exit(1)
  }
  const raw = yaml.load(fs.readFileSync(configPath, 'utf8'))
  if (!raw.ureport_url || !raw.agent_token) {
    console.error('[agent] ureport_url and agent_token are required in config')
    process.exit(1)
  }
  if (raw.agent_token === 'PASTE_YOUR_TOKEN_HERE') {
    console.error('[agent] replace PASTE_YOUR_TOKEN_HERE with a real token from /auto-heal')
    process.exit(1)
  }
  let envFile
  try {
    envFile = agentEnv.loadEnvFile(configPath, raw.env_file)
  } catch (err) {
    console.error(`[agent] invalid config: ${err.message}`)
    process.exit(1)
  }
  // Heads-up that variables came from a file. Names only: the values stay out of the log
  for (const { level, text } of agentEnv.envFileNotice(envFile, process.env)) {
    (level === 'warn' ? console.warn : console.log)(`[agent] ${text}`)
  }
  let gitHosts
  try {
    gitHosts = normalizeGitHosts(raw.git_hosts)
  } catch (err) {
    console.error(`[agent] invalid config: ${err.message}`)
    process.exit(1)
  }
  return {
    ureport_url:                raw.ureport_url.trim().replace(/\/+$/, ''),
    agent_token:                raw.agent_token.trim(),
    repo_path:                  raw.repo_path ? path.resolve(raw.repo_path.trim()) : path.resolve(process.cwd(), 'workspace'),
    ai_model:                   raw.ai_model || 'claude-sonnet-4-6',
    claude_cli_timeout_minutes:  raw.claude_cli_timeout_minutes  ? Number(raw.claude_cli_timeout_minutes)  : null,
    gemini_cli_timeout_minutes:  raw.gemini_cli_timeout_minutes  ? Number(raw.gemini_cli_timeout_minutes)  : null,
    signing_secret:       raw.signing_secret       ? String(raw.signing_secret).trim()                : null,
    allowed_run_prefixes: Array.isArray(raw.allowed_run_prefixes)
      ? raw.allowed_run_prefixes.map(p => String(p).trim()).filter(Boolean)
      : (raw.allowed_run_prefixes ? [String(raw.allowed_run_prefixes).trim()] : []),
    accept_job_types: Array.isArray(raw.accept_job_types)
      ? raw.accept_job_types
      : ['heal', 'rerun'],
    audit_log: raw.audit_log ? path.resolve(String(raw.audit_log).trim()) : null,
    git_hosts: gitHosts,
    env_file_vars: envFile.vars,
  }
}

module.exports = { loadConfig }
