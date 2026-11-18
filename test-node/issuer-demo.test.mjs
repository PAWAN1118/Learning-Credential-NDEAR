import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import * as Ed25519Multikey from '@digitalcredentials/ed25519-multikey'

test('demo issuer issues a signed badge that verifies and can be revoked', async (t) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'ndear-issuer-demo-'))
  const port = 43000 + Math.floor(Math.random() * 10000)
  const base = `http://127.0.0.1:${port}`
  const server = spawn(process.execPath, ['issuer-demo/server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      ISSUER_DEMO_PUBLIC_URL: base,
      ISSUER_DEMO_DATA_DIR: dataDirectory
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  t.after(async () => {
    server.kill()
    await rm(dataDirectory, { recursive: true, force: true })
  })

  let output = ''
  server.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk })
  server.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk })

  let issuers
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Issuer server exited: ${output}`)
    try {
      const response = await fetch(`${base}/api/issuers`)
      if (response.ok) {
        issuers = await response.json()
        break
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  assert.equal(issuers?.length, 3, output)
  assert.equal(new Set(issuers.map(({ did }) => did)).size, 3)
  const token = output.match(/Issuer admin token \(keep local\): ([\w-]+)/)?.[1]
  assert.ok(token, output)

  const issueResponse = await fetch(`${base}/api/credentials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      issuerId: issuers[0].id,
      learnerName: 'Local Demo Learner',
      achievementName: 'Credential Smoke Check'
    })
  })
  const issued = await issueResponse.json()
  assert.equal(issueResponse.status, 201, JSON.stringify(issued))
  assert.ok(issued.credential.proof, 'issued credential must have a cryptographic proof')
  assert.match(issued.walletLink, /^ndear:\/\/certificate\/import\?url=/)
  assert.equal(issued.credential.type.includes('OpenBadgeCredential'), true)
  assert.match(issued.jwt, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  assert.ok(issued.formats.json.endsWith('.json'))
  assert.ok(issued.formats.jsonld.endsWith('.jsonld'))
  assert.ok(issued.formats.jwt.endsWith('.jwt'))
  assert.ok(issued.formats.png.endsWith('.png'))

  const jsonVc = await (await fetch(issued.formats.json)).json()
  const jsonLdVc = await (await fetch(issued.formats.jsonld)).json()
  assert.equal(jsonVc.id, issued.credential.id)
  assert.equal(jsonLdVc.id, issued.credential.id)
  const jwtBody = await (await fetch(issued.formats.jwt)).text()
  assert.equal(jwtBody, issued.jwt)
  const pngResponse = await fetch(issued.formats.png)
  const pngBytes = new Uint8Array(await pngResponse.arrayBuffer())
  assert.equal(pngResponse.headers.get('content-type'), 'image/png')
  assert.deepEqual([...pngBytes.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const pngText = new TextDecoder().decode(pngBytes)
  assert.match(pngText, /openbadgecredential/)
  const jsonStart = pngText.indexOf('{', pngText.indexOf('openbadgecredential'))
  let depth = 0
  let jsonEnd = jsonStart
  while (jsonEnd < pngText.length) {
    if (pngText[jsonEnd] === '{') depth += 1
    else if (pngText[jsonEnd] === '}') depth -= 1
    if (depth === 0) break
    jsonEnd += 1
  }
  const badgeJson = JSON.parse(pngText.slice(jsonStart, jsonEnd + 1))
  assert.equal(badgeJson.id, issued.credential.id)
  const openBadges = await (await fetch(issued.formats.openBadges)).json()
  assert.equal(openBadges.id, issued.credential.id)

  const [encodedHeader, encodedPayload, encodedSignature] = issued.jwt.split('.')
  const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString())
  assert.equal(payload.vc.id, issued.credential.id)
  const key = await Ed25519Multikey.from({
    id: issuers[0].did + '#' + issuers[0].did.slice('did:key:'.length),
    controller: issuers[0].did,
    publicKeyMultibase: issuers[0].did.slice('did:key:'.length)
  })
  const jwtValid = await key.verifier().verify({
    data: Buffer.from(`${encodedHeader}.${encodedPayload}`),
    signature: Buffer.from(encodedSignature, 'base64url')
  })
  assert.equal(jwtValid, true, 'JWT envelope signature must verify with the issuer did:key')
  const tamperedValid = await key.verifier().verify({
    data: Buffer.from(`${encodedHeader}.${encodedPayload}`),
    signature: Buffer.from(`${encodedSignature.slice(0, -4)}abcd`, 'base64url')
  })
  assert.equal(tamperedValid, false)

  for (const issuer of issuers.slice(1)) {
    const otherResponse = await fetch(`${base}/api/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        issuerId: issuer.id,
        learnerName: 'Local Demo Learner',
        achievementName: `Credential from ${issuer.name}`
      })
    })
    const otherIssued = await otherResponse.json()
    assert.equal(otherResponse.status, 201, JSON.stringify(otherIssued))
    assert.equal(otherIssued.credential.issuer.id, issuer.did)
    const otherId = otherIssued.credential.id.split('/').pop()
    const otherVerified = await (await fetch(`${base}/api/verify/${otherId}`)).json()
    assert.equal(otherVerified.verified, true, `${issuer.name}: ${JSON.stringify(otherVerified.log)}`)
  }

  const credentialId = issued.credential.id.split('/').pop()
  const verifyUrl = `${base}/api/verify/${credentialId}`
  const statusResponse = await fetch(`${base}/api/status-lists/${issuers[0].id}`)
  assert.equal(statusResponse.status, 200, `${await statusResponse.text()}\n${output}`)
  let verified = await (await fetch(verifyUrl)).json()
  assert.equal(verified.verified, true, `${JSON.stringify(verified.log)}\n${output}`)
  assert.equal(verified.revoked, false)

  const publicVerification = await fetch(`${base}/api/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential: issued.credential })
  })
  assert.equal(publicVerification.status, 200)
  assert.equal((await publicVerification.json()).verified, true)

  const tamperedCredential = JSON.parse(JSON.stringify(issued.credential))
  tamperedCredential.proof.proofValue = `${tamperedCredential.proof.proofValue.slice(0, -2)}AA`
  const tamperedVerification = await fetch(`${base}/api/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential: tamperedCredential })
  })
  assert.equal(tamperedVerification.status, 200)
  assert.equal((await tamperedVerification.json()).verified, false)

  const malformedVerification = await fetch(`${base}/api/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notACredential: true })
  })
  assert.equal(malformedVerification.status, 400)

  const revokeResponse = await fetch(`${base}/api/credentials/${credentialId}/revoke`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }
  })
  assert.equal(revokeResponse.status, 200)
  verified = await (await fetch(verifyUrl)).json()
  assert.equal(verified.verified, false, 'a revoked credential must fail verification')
  assert.equal(verified.revoked, true)
})
