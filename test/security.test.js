import test from 'node:test'
import assert from 'node:assert/strict'
import { assertNonSensitivePath, isPrivateAddress, validatePublicUrl } from '../src/security.js'

test('private network addresses are detected', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.2', '192.168.1.2', '::1', 'fd00::1']) {
    assert.equal(isPrivateAddress(address), true, address)
  }
  assert.equal(isPrivateAddress('8.8.8.8'), false)
  assert.equal(isPrivateAddress('2606:4700:4700::1111'), false)
})

test('public URL validation rejects private DNS answers', async () => {
  await assert.rejects(
    validatePublicUrl('https://example.test/source', {
      lookupFn: async () => [{ address: '127.0.0.1', family: 4 }],
    }),
    /private or invalid/,
  )
})

test('host allowlist is enforced', async () => {
  await assert.rejects(
    validatePublicUrl('https://example.com/source', {
      allowedHosts: new Set(['docs.example.com']),
      lookupFn: async () => [{ address: '93.184.216.34', family: 4 }],
    }),
    /not allowlisted/,
  )
})

test('credential-like local files are rejected', () => {
  for (const candidate of ['/project/.env', '/project/.env.production', '/project/id_ed25519', '/project/private.pem']) {
    assert.throws(() => assertNonSensitivePath(candidate), /Sensitive credential file/)
  }
  assert.doesNotThrow(() => assertNonSensitivePath('/project/.env.example'))
  assert.doesNotThrow(() => assertNonSensitivePath('/project/paper.md'))
})
