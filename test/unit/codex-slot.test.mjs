import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseCodexCredentialInput,
  upsertCodexAccount,
  readCodexAccounts,
  summarizeCodexSlot,
  writeCodexAccounts,
} from '../../src/lib/vm/codex-slot.mjs'

test('parseCodexCredentialInput accepts Codex CLI auth.json', () => {
  const parsed = parseCodexCredentialInput({
    tokens: {
      access_token: 'eyJhbGciOiaccess',
      refresh_token: 'rt-1',
      id_token: 'id-1',
    },
    account_id: 'acc-uuid',
  })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.account.access_token, 'eyJhbGciOiaccess')
  assert.equal(parsed.account.refresh_token, 'rt-1')
  assert.equal(parsed.account.chatgpt_account_id, 'acc-uuid')
})

test('parseCodexCredentialInput accepts kernel accounts file', () => {
  const parsed = parseCodexCredentialInput(
    JSON.stringify({
      accounts: [
        {
          id: 'user@example.com',
          access_token: 'at',
          refresh_token: 'rt',
          chatgpt_account_id: 'org-1',
        },
      ],
    }),
  )
  assert.equal(parsed.ok, true)
  assert.equal(parsed.account.email, 'user@example.com')
  assert.equal(parsed.account.chatgpt_account_id, 'org-1')
})

test('parseCodexCredentialInput rejects Claude sessionKey JSON', () => {
  const parsed = parseCodexCredentialInput({ session_key: 'sk-ant-sid01-xxx' })
  assert.equal(parsed.ok, false)
  assert.equal(parsed.error, 'missing_token')
})

test('parseCodexCredentialInput accepts AT-only paste', () => {
  const parsed = parseCodexCredentialInput('eyJhbGciOiaccess', { mode: 'access_token' })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.account.access_token, 'eyJhbGciOiaccess')
  assert.equal(parsed.account.refresh_token, '')
})

test('parseCodexCredentialInput accepts RT-only paste', () => {
  const parsed = parseCodexCredentialInput('rt-only-1\nrt-ignored', { mode: 'refresh_token' })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.account.refresh_token, 'rt-only-1')
  assert.equal(parsed.account.access_token, '')
  assert.equal(parsed.extra_count, 1)
})

test('parseCodexCredentialInput accepts camelCase credentials object', () => {
  const parsed = parseCodexCredentialInput({
    credentials: { accessToken: 'at-2', refreshToken: 'rt-2', idToken: 'id-2' },
  })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.account.access_token, 'at-2')
  assert.equal(parsed.account.refresh_token, 'rt-2')
})

test('parseCodexCredentialInput accepts CPR openai document', () => {
  const parsed = parseCodexCredentialInput({
    documents: [
      { provider: 'xai', document: { refreshToken: 'xai-rt' } },
      { provider: 'openai', document: { accounts: [{ accessToken: 'cpr-at', refreshToken: 'cpr-rt' }] } },
    ],
  })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.account.access_token, 'cpr-at')
  assert.equal(parsed.account.refresh_token, 'cpr-rt')
})

test('parseCodexCredentialInput rejects OPENAI_API_KEY-only client config', () => {
  const parsed = parseCodexCredentialInput({ OPENAI_API_KEY: 'sk-proj-not-oauth' })
  assert.equal(parsed.ok, false)
  assert.equal(parsed.error, 'not_oauth_account')
})

test('upsertCodexAccount writes credential file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-slot-'))
  fs.mkdirSync(path.join(root, 'vms', 'vm-codex-01'), { recursive: true })
  upsertCodexAccount(root, 'vm-codex-01', {
    access_token: 'at',
    refresh_token: 'rt',
    chatgpt_account_id: 'org-9',
  })
  const accounts = readCodexAccounts(root, 'vm-codex-01')
  assert.equal(accounts.length, 1)
  assert.equal(accounts[0].access_token, 'at')
  assert.equal(accounts[0].chatgpt_account_id, 'org-9')
  fs.rmSync(root, { recursive: true, force: true })
})

test('imported Codex account defaults to unlimited kernel concurrency', () => {
  const parsed = parseCodexCredentialInput({
    tokens: { access_token: 'at', refresh_token: 'rt' },
    account_id: 'acc-uuid',
  })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.account.max_concurrency, 0)
  assert.equal(parsed.account.rpm, 0)
})

test('slot summary carries the RPM the kernel enforces across its accounts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-rpm-'))
  try {
    writeCodexAccounts(root, 'vm-a', [{ id: 'a', access_token: 'at', rpm: 6 }])
    assert.equal(summarizeCodexSlot(root, { id: 'vm-a' }).account_rpm, 6)
    writeCodexAccounts(root, 'vm-a', [
      { id: 'a', access_token: 'at', rpm: 6 },
      { id: 'b', access_token: 'at', rpm: 4 },
    ])
    assert.equal(summarizeCodexSlot(root, { id: 'vm-a' }).account_rpm, 10)
    // One account without a cap leaves the slot uncapped.
    writeCodexAccounts(root, 'vm-a', [
      { id: 'a', access_token: 'at', rpm: 6 },
      { id: 'b', access_token: 'at', rpm: 0 },
    ])
    assert.equal(summarizeCodexSlot(root, { id: 'vm-a' }).account_rpm, null)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
