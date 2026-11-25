'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { findPullRequestUrl } = require('../lib/ai-fix')

test('finds GitHub, Bitbucket and GitLab links, the last one, without trailing punctuation', () => {
  assert.equal(findPullRequestUrl('PR: https://github.com/o/r/pull/12.'), 'https://github.com/o/r/pull/12')
  assert.equal(findPullRequestUrl('(https://bitbucket.org/o/r/pull-requests/7)'), 'https://bitbucket.org/o/r/pull-requests/7')
  assert.equal(findPullRequestUrl('https://gitlab.com/o/r/-/merge_requests/9'), 'https://gitlab.com/o/r/-/merge_requests/9')
  assert.equal(findPullRequestUrl('old https://github.com/o/r/pull/1 then new https://github.com/o/r/pull/2'), 'https://github.com/o/r/pull/2')
})

test('ignores text without a pull request link, and non-text input', () => {
  assert.equal(findPullRequestUrl('see https://plusgrade.atlassian.net/browse/QVF-5', undefined, null), null)
  assert.equal(findPullRequestUrl(), null)
})
