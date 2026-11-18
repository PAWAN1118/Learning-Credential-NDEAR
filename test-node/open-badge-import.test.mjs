import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { credentialsFrom } = require('../app/lib/decode.ts')

test('imports a signed Open Badges VC from an alternate JSON representation', async () => {
  const credential = {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: 'urn:uuid:badge-1',
    type: ['VerifiableCredential', 'OpenBadgeCredential'],
    issuer: 'https://issuer.example',
    credentialSubject: { achievement: { name: 'Demo badge' } },
    proof: { type: 'DataIntegrityProof' }
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url) === 'https://issuer.example/badge/1') {
      return new Response(
        '<html><head><link rel="alternate" type="application/ld+json" href="/badge/1.json"></head></html>',
        { headers: { 'content-type': 'text/html' } }
      )
    }
    assert.equal(String(url), 'https://issuer.example/badge/1.json')
    return new Response(JSON.stringify(credential), {
      headers: { 'content-type': 'application/ld+json' }
    })
  }

  try {
    const result = await credentialsFrom('https://issuer.example/badge/1')
    assert.equal(result.length, 1)
    assert.deepEqual(result[0], credential)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('explains when a QR only opens a page without a credential', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response('<html><body>Enter badge ID</body></html>', {
      headers: { 'content-type': 'text/html' }
    })
  try {
    await assert.rejects(
      credentialsFrom('https://issuer.example/'),
      /does not provide the signed Open Badges credential/
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
