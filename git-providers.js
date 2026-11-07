'use strict'
// Git hosting providers used by the Create PR stage.
// Built-in: github.com, gitlab.com, bitbucket.org. Self-hosted GitHub Enterprise and GitLab
// are enabled through `git_hosts` in the agent's local ureport-agent.yml (never from a playbook,
// because the PR token is sent to whatever API host is resolved here).

const BUILTIN_HOSTS = {
  'github.com':    { provider: 'github',    apiUrl: 'https://api.github.com' },
  'gitlab.com':    { provider: 'gitlab',    apiUrl: 'https://gitlab.com/api/v4' },
  'bitbucket.org': { provider: 'bitbucket', apiUrl: 'https://api.bitbucket.org/2.0' },
}

const SUPPORTED_PROVIDERS = ['github', 'gitlab', 'bitbucket']

// Default API base for a self-hosted instance of a provider
function defaultApiUrl(provider, host) {
  if (provider === 'github') return `https://${host}/api/v3`
  if (provider === 'gitlab') return `https://${host}/api/v4`
  return null
}

// Normalise the `git_hosts` yml map: { 'git.corp.com': { provider, api_url? } }
function normalizeGitHosts(raw) {
  const hosts = {}
  if (!raw || typeof raw !== 'object') return hosts
  for (const [rawHost, conf] of Object.entries(raw)) {
    const host = rawHost.trim().toLowerCase()
    const provider = String(conf?.provider || '').trim().toLowerCase()
    if (!SUPPORTED_PROVIDERS.includes(provider)) {
      throw new Error(`git_hosts.${host}: provider must be one of ${SUPPORTED_PROVIDERS.join(', ')}`)
    }
    const apiUrl = (conf.api_url ? String(conf.api_url).trim() : defaultApiUrl(provider, host))
    if (!apiUrl) throw new Error(`git_hosts.${host}: api_url is required for provider "${provider}"`)
    hosts[host] = { provider, apiUrl: apiUrl.replace(/\/+$/, '') }
  }
  return hosts
}

// Split a git remote (https, ssh://, scp-style git@host:path) into host and path segments
function splitRemote(remote) {
  const url = String(remote || '').trim()
  let m = url.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i)
  if (!m) m = url.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/) // git@host:group/repo.git
  if (!m) return null
  const parts = m[2].replace(/\.git$/, '').split('/').filter(Boolean)
  return parts.length >= 2 ? { host: m[1].toLowerCase(), parts } : null
}

// Resolve a remote to { provider, apiUrl, host, repoPath, owner, repo }; throws a clear error otherwise.
function resolveRemote(remote, gitHosts = {}) {
  const split = splitRemote(remote)
  if (!split) throw new Error(`Cannot parse git remote: ${remote}`)
  const conf = gitHosts[split.host] || BUILTIN_HOSTS[split.host]
  if (!conf) {
    throw new Error(
      `Unsupported git host "${split.host}". Built in: ${Object.keys(BUILTIN_HOSTS).join(', ')}. ` +
      `For a self-hosted GitHub or GitLab, add it under git_hosts in ureport-agent.yml.`,
    )
  }
  return {
    provider: conf.provider,
    apiUrl: conf.apiUrl,
    host: split.host,
    parts: split.parts,
    repoPath: split.parts.join('/'),
    owner: split.parts[0],
    repo: split.parts[split.parts.length - 1],
  }
}

async function readJson(resp) {
  try { return await resp.json() } catch { return {} }
}

async function createGitHubPr(t, p) {
  const resp = await fetch(`${t.apiUrl}/repos/${encodeURIComponent(t.parts[0])}/${encodeURIComponent(t.parts[1])}/pulls`, {
    method: 'POST',
    headers: { Authorization: `token ${p.token}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json', 'User-Agent': 'ureport-agent' },
    body: JSON.stringify({ title: p.title, body: p.body, head: p.head, base: p.base }),
  })
  const data = await readJson(resp)
  if (!resp.ok) throw new Error(`GitHub API ${resp.status}: ${data.message || resp.statusText}`)
  return data.html_url
}

async function createGitLabMr(t, p) {
  const project = encodeURIComponent(t.repoPath)
  const resp = await fetch(`${t.apiUrl}/projects/${project}/merge_requests`, {
    method: 'POST',
    headers: { 'PRIVATE-TOKEN': p.token, 'Content-Type': 'application/json', 'User-Agent': 'ureport-agent' },
    body: JSON.stringify({ title: p.title, description: p.body, source_branch: p.head, target_branch: p.base }),
  })
  const data = await readJson(resp)
  if (!resp.ok) throw new Error(`GitLab API ${resp.status}: ${JSON.stringify(data.message || data.error || data)}`)
  return data.web_url
}

// Default reviewers (repo + project level) for a Bitbucket Cloud repo, excluding the token's own user
// because Bitbucket rejects a PR whose author is also a reviewer. Never throws: returns [] on any problem.
async function fetchBitbucketDefaultReviewers(t, headers) {
  try {
    let selfUuid = null
    try {
      const me = await fetch(`${t.apiUrl}/user`, { headers })
      if (me.ok) selfUuid = (await me.json()).uuid
    } catch { /* author unknown; the retry without reviewers covers a rejection */ }

    const reviewers = []
    let url = `${t.apiUrl}/repositories/${t.parts[0]}/${t.parts[1]}/effective-default-reviewers?pagelen=50`
    for (let page = 0; url && page < 5; page++) {
      const resp = await fetch(url, { headers })
      if (!resp.ok) {
        console.warn(`[create-pr] Could not read default reviewers (${resp.status}); creating PR without reviewers`)
        return []
      }
      const data = await resp.json()
      for (const v of data.values || []) {
        const uuid = v.user?.uuid
        if (uuid && uuid !== selfUuid && !reviewers.some((r) => r.uuid === uuid)) reviewers.push({ uuid })
      }
      url = data.next || null
    }
    return reviewers
  } catch (err) {
    console.warn(`[create-pr] Default reviewer lookup failed: ${err.message}`)
    return []
  }
}

async function createBitbucketPr(t, p) {
  const authHeader = p.username
    ? `Basic ${Buffer.from(`${p.username}:${p.token}`).toString('base64')}`
    : `Bearer ${p.token}`
  const headers = { Authorization: authHeader, 'Content-Type': 'application/json', 'User-Agent': 'ureport-agent' }
  const endpoint = `${t.apiUrl}/repositories/${t.parts[0]}/${t.parts[1]}/pullrequests`
  const payload = { title: p.title, description: p.body, source: { branch: { name: p.head } }, destination: { branch: { name: p.base } } }
  const reviewers = await fetchBitbucketDefaultReviewers(t, headers)

  // Bitbucket does not apply default reviewers to API-created PRs, so pass them explicitly.
  let resp = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(reviewers.length ? { ...payload, reviewers } : payload) })
  let data = await readJson(resp)
  if (!resp.ok && reviewers.length) {
    // A bad reviewer entry must not block the PR; retry without reviewers.
    console.warn(`[create-pr] Bitbucket rejected PR with default reviewers (${resp.status}); retrying without reviewers`)
    resp = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload) })
    data = await readJson(resp)
  }
  if (!resp.ok) throw new Error(`Bitbucket API ${resp.status}: ${data.error?.message || JSON.stringify(data)}`)
  return data.links?.html?.href
}

const CREATORS = { github: createGitHubPr, gitlab: createGitLabMr, bitbucket: createBitbucketPr }

// target = resolveRemote() result; params = { token, username, title, body, head, base }
async function createPullRequest(target, params) {
  const prUrl = await CREATORS[target.provider](target, params)
  if (!prUrl) throw new Error('PR created but no URL returned from API')
  return prUrl
}

module.exports = { normalizeGitHosts, resolveRemote, createPullRequest, splitRemote }
