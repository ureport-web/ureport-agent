'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { normalizeGitHosts, resolveRemote, createPullRequest, splitRemote } = require('../git-providers')
const { startPrApi } = require('./helpers/agent-harness')

test('splitRemote reads https, ssh:// and scp style remotes', () => {
  assert.deepEqual(splitRemote('https://github.com/org/repo.git'), { host: 'github.com', parts: ['org', 'repo'] })
  assert.deepEqual(splitRemote('https://user@git.corp.com:8443/group/sub/repo'), { host: 'git.corp.com', parts: ['group', 'sub', 'repo'] })
  assert.deepEqual(splitRemote('ssh://git@Bitbucket.org/ws/repo.git'), { host: 'bitbucket.org', parts: ['ws', 'repo'] })
  assert.deepEqual(splitRemote('git@gitlab.com:g/r.git'), { host: 'gitlab.com', parts: ['g', 'r'] })
})

test('splitRemote refuses what is not a repository address', () => {
  assert.equal(splitRemote(''), null)
  assert.equal(splitRemote(undefined), null)
  assert.equal(splitRemote('not a remote'), null)
  assert.equal(splitRemote('https://github.com/only-one'), null)
})

test('normalizeGitHosts reads the yml map and names the host that is wrong', () => {
  assert.deepEqual(normalizeGitHosts(undefined), {})
  assert.deepEqual(normalizeGitHosts('text'), {})
  assert.deepEqual(normalizeGitHosts({ ' Git.Corp.com ': { provider: 'GitHub' } }), { 'git.corp.com': { provider: 'github', apiUrl: 'https://git.corp.com/api/v3' } })
  assert.deepEqual(normalizeGitHosts({ 'lab.corp.com': { provider: 'gitlab', api_url: ' https://lab.corp.com/api/v4/// ' } }), { 'lab.corp.com': { provider: 'gitlab', apiUrl: 'https://lab.corp.com/api/v4' } })
  assert.throws(() => normalizeGitHosts({ 'x.com': { provider: 'svn' } }), /git_hosts.x.com: provider must be one of/)
  assert.throws(() => normalizeGitHosts({ 'x.com': null }), /provider must be one of/)
  assert.throws(() => normalizeGitHosts({ 'bb.corp.com': { provider: 'bitbucket' } }), /api_url is required for provider "bitbucket"/)
})

test('resolveRemote finds built-in and configured hosts, and explains the rest', () => {
  const t = resolveRemote('git@github.com:org/repo.git')
  assert.deepEqual([t.provider, t.apiUrl, t.owner, t.repo, t.repoPath], ['github', 'https://api.github.com', 'org', 'repo', 'org/repo'])
  assert.equal(resolveRemote('https://gitlab.com/g/s/r.git').repoPath, 'g/s/r')
  assert.equal(resolveRemote('https://bitbucket.org/w/r').provider, 'bitbucket')
  const hosts = normalizeGitHosts({ 'git.corp.com': { provider: 'github' } })
  assert.equal(resolveRemote('git@git.corp.com:a/b.git', hosts).apiUrl, 'https://git.corp.com/api/v3')
  assert.throws(() => resolveRemote('garbage'), /Cannot parse git remote/)
  assert.throws(() => resolveRemote('git@nowhere.example:a/b.git'), /Unsupported git host "nowhere.example"/)
})

const target = (api, provider, extra = {}) => ({ provider, apiUrl: api.url, parts: ['owner', 'repo'], repoPath: 'owner/repo', ...extra })
const params = { token: 'tok', title: 'T', body: 'B', head: 'fix/x', base: 'main' }
let api
test.afterEach(async () => { if (api) await api.close(); api = null })

test('GitHub: posts the pull request and returns its page, or the API message when refused', async () => {
  api = await startPrApi((r) => (r.body.title === 'refuse' ? { status: 422, body: { message: 'nope' } } : { status: 201, body: { html_url: 'https://gh/pull/1' } }))
  assert.equal(await createPullRequest(target(api, 'github'), params), 'https://gh/pull/1')
  assert.equal(api.requests[0].headers.authorization, 'token tok')
  await assert.rejects(createPullRequest(target(api, 'github'), { ...params, title: 'refuse' }), /GitHub API 422: nope/)
})

test('GitHub: a refusal with no readable body still names the status', async () => {
  api = await startPrApi(() => ({ status: 500, raw: 'oops not json' }))
  await assert.rejects(createPullRequest(target(api, 'github'), params), /GitHub API 500/)
})

test('a created pull request with no address in the answer is an error', async () => {
  api = await startPrApi(() => ({ status: 201, body: {} }))
  await assert.rejects(createPullRequest(target(api, 'github'), params), /no URL returned/)
})

test('GitLab: posts the merge request, and reports the API error', async () => {
  api = await startPrApi((r) => (r.body.title === 'refuse' ? { status: 409, body: { message: ['dup'] } } : { status: 201, body: { web_url: 'https://gl/mr/2' } }))
  assert.equal(await createPullRequest(target(api, 'gitlab', { repoPath: 'g/s/r' }), params), 'https://gl/mr/2')
  assert.equal(api.requests[0].url, '/projects/g%2Fs%2Fr/merge_requests')
  await assert.rejects(createPullRequest(target(api, 'gitlab'), { ...params, title: 'refuse' }), /GitLab API 409: \["dup"\]/)
  api.requests.length = 0
  await assert.rejects(createPullRequest(target(api, 'gitlab'), { ...params, title: 'refuse' }), /GitLab API/)
})

const bitbucketHandler = ({ reviewers = true, rejectWithReviewers = false, userOk = true, reviewerStatus = 200, pages = 1, self = 'me' } = {}) => (r) => {
  if (r.url === '/user') return userOk ? { body: { uuid: self } } : { status: 401, body: {} }
  if (r.url.startsWith('/repositories/owner/repo/effective-default-reviewers')) {
    if (reviewerStatus !== 200) return { status: reviewerStatus, body: {} }
    const page = r.url.includes('page2') ? 2 : 1
    const values = page === 1 ? [{ user: { uuid: 'a' } }, { user: { uuid: self } }, { user: { uuid: 'a' } }, {}] : [{ user: { uuid: 'b' } }]
    return { body: { values: reviewers ? values : [], next: page < pages ? `${r.headers.host ? 'http://' + r.headers.host : ''}/repositories/owner/repo/effective-default-reviewers?page2=1` : null } }
  }
  if (r.url === '/repositories/owner/repo/pullrequests') {
    if (rejectWithReviewers && r.body.reviewers) return { status: 400, body: { error: { message: 'bad reviewer' } } }
    return { status: 201, body: { links: { html: { href: 'https://bb/pr/3' } } } }
  }
  return { status: 404, body: {} }
}

test('Bitbucket: adds the default reviewers, without the author or repeats, and follows paging', async () => {
  api = await startPrApi(bitbucketHandler({ pages: 2 }))
  assert.equal(await createPullRequest(target(api, 'bitbucket'), params), 'https://bb/pr/3')
  const post = api.requests.find((r) => r.method === 'POST')
  assert.deepEqual(post.body.reviewers, [{ uuid: 'a' }, { uuid: 'b' }])
  assert.equal(post.headers.authorization, 'Bearer tok')
})

test('Bitbucket: a username switches to basic authentication', async () => {
  api = await startPrApi(bitbucketHandler({ reviewers: false }))
  await createPullRequest(target(api, 'bitbucket'), { ...params, username: 'bob' })
  assert.equal(api.requests.find((r) => r.method === 'POST').headers.authorization, `Basic ${Buffer.from('bob:tok').toString('base64')}`)
  assert.equal(api.requests.find((r) => r.method === 'POST').body.reviewers, undefined)
})

test('Bitbucket: a rejected reviewer list is retried without reviewers', async () => {
  api = await startPrApi(bitbucketHandler({ rejectWithReviewers: true }))
  assert.equal(await createPullRequest(target(api, 'bitbucket'), params), 'https://bb/pr/3')
  assert.equal(api.requests.filter((r) => r.method === 'POST').length, 2)
})

test('Bitbucket: reviewers that cannot be read, or an unknown author, do not stop the pull request', async () => {
  api = await startPrApi(bitbucketHandler({ reviewerStatus: 403 }))
  assert.equal(await createPullRequest(target(api, 'bitbucket'), params), 'https://bb/pr/3')
  await api.close()
  api = await startPrApi(bitbucketHandler({ userOk: false }))
  assert.equal(await createPullRequest(target(api, 'bitbucket'), params), 'https://bb/pr/3')
})

test('Bitbucket: an unreachable reviewer lookup does not stop the pull request, and a refused one reports the API error', async () => {
  api = await startPrApi(bitbucketHandler())
  const t = target(api, 'bitbucket')
  const original = global.fetch
  let first = true
  global.fetch = (url, opts) => { if (first && String(url).includes('/user')) { first = false; throw new Error('network') } return original(url, opts) }
  try { assert.equal(await createPullRequest(t, params), 'https://bb/pr/3') } finally { global.fetch = original }
  await api.close()
  api = await startPrApi(() => ({ status: 400, body: { error: { message: 'bad branch' } } }))
  await assert.rejects(createPullRequest(target(api, 'bitbucket'), params), /Bitbucket API 400: bad branch/)
  await api.close()
  api = await startPrApi(() => ({ status: 500, body: { other: 1 } }))
  await assert.rejects(createPullRequest(target(api, 'bitbucket'), params), /Bitbucket API 500: \{"other":1\}/)
})

test('Bitbucket: the whole reviewer lookup failing is a warning and the pull request goes on', async () => {
  api = await startPrApi(bitbucketHandler())
  const original = global.fetch
  global.fetch = (url, opts) => { if (String(url).includes('effective-default-reviewers')) throw new Error('boom'); return original(url, opts) }
  try { assert.equal(await createPullRequest(target(api, 'bitbucket'), params), 'https://bb/pr/3') } finally { global.fetch = original }
})
