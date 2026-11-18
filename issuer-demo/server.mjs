import { createServer } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { deflateSync } from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import QRCode from 'qrcode'

import * as vc from '@digitalcredentials/vc'
import * as Ed25519Multikey from '@digitalcredentials/ed25519-multikey'
import { DataIntegrityProof } from '@digitalcredentials/data-integrity'
import { cryptosuite } from '@digitalcredentials/eddsa-rdfc-2022-cryptosuite'
import { securityLoader } from '@digitalcredentials/security-document-loader'
const require = createRequire(import.meta.url)
const bitstringStatusListModule = require('@digitalcredentials/vc-bitstring-status-list')

const {
  BitstringStatusList,
  createCredential: createStatusListCredential,
  VC_BSL_VC_V1_CONTEXT
} = bitstringStatusListModule

const directory = path.dirname(fileURLToPath(import.meta.url))
const dataDirectory = path.resolve(
  process.env.ISSUER_DEMO_DATA_DIR || path.join(directory, '..', '.issuer-demo-data')
)
const statePath = path.join(dataDirectory, 'state.json')
const keyPath = path.join(dataDirectory, 'issuer-keys.json')
const port = Number(process.env.PORT || 4170)
const host = process.env.HOST || '0.0.0.0'
const publicBaseUrl = (process.env.ISSUER_DEMO_PUBLIC_URL || `http://${host}:${port}`).replace(/\/$/, '')
const adminToken = process.env.ISSUER_DEMO_ADMIN_TOKEN || randomUUID()
const didContext = 'https://www.w3.org/ns/did/v1'
const multikeyContext = 'https://w3id.org/security/multikey/v1'
const vcContext = 'https://www.w3.org/ns/credentials/v2'
const obContext = 'https://purl.imsglobal.org/spec/ob/v3p0/context-3.0.3.json'
const obData = 'https://w3id.org/security/data-integrity/v2'
const statusListLength = 131072

const issuerDefinitions = [
  { id: 'institution-a', name: 'Demo Institution A', location: 'Demo issuer' },
  { id: 'institution-b', name: 'Demo Institution B', location: 'Demo issuer' },
  { id: 'institution-c', name: 'Demo Institution C', location: 'Demo issuer' }
]

const documentLoader = securityLoader().build()
const state = await loadState()
const issuers = await loadIssuers()
const statusLists = await buildStatusLists()

async function jsonFile(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw error
  }
}

async function saveJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

async function loadState() {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 })
  const loaded = await jsonFile(statePath, { credentials: [], revoked: [], nextIndex: {} })
  loaded.credentials ??= []
  loaded.revoked ??= []
  loaded.nextIndex ??= {}
  return loaded
}

async function loadIssuers() {
  let storedKeys = await jsonFile(keyPath, null)
  if (!storedKeys) {
    storedKeys = {}
    for (const definition of issuerDefinitions) {
      const generated = await Ed25519Multikey.generate()
      const did = `did:key:${generated.publicKeyMultibase}`
      const key = await Ed25519Multikey.from({
        ...await generated.export({ publicKey: true, secretKey: true, includeContext: true }),
        id: `${did}#${generated.publicKeyMultibase}`,
        controller: did
      })
      storedKeys[definition.id] = await key.export({
        publicKey: true,
        secretKey: true,
        includeContext: true
      })
    }
    await saveJson(keyPath, storedKeys)
  }

  const result = new Map()
  for (const definition of issuerDefinitions) {
    const key = await Ed25519Multikey.from(storedKeys[definition.id])
    const did = key.controller
    const publicKey = await key.export({ publicKey: true, includeContext: true })
    result.set(definition.id, { ...definition, did, key, publicKey })
  }
  return result
}

function suiteFor(issuer) {
  return new DataIntegrityProof({
    signer: issuer.key.signer(),
    cryptosuite
  })
}

async function signedCredential(credential, issuer) {
  return vc.issue({
    credential,
    suite: suiteFor(issuer),
    documentLoader
  })
}

function base64Url(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value)
  return buffer.toString('base64url')
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type)
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])))
  return Buffer.concat([length, typeBuffer, data, crc])
}

function bakeOpenBadgePng(credential) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0)
  ihdr.writeUInt32BE(1, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const itxt = Buffer.concat([
    Buffer.from('openbadgecredential\0\0\0\0\0'),
    Buffer.from(JSON.stringify(credential))
  ])
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('iTXt', itxt),
    pngChunk('IDAT', deflateSync(Buffer.from([0, 0x10, 0x25, 0x38]))),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

async function jwtFor(credential, issuer) {
  const issuedAt = Math.floor(
    Date.parse(credential.validFrom ?? credential.issuanceDate) / 1000
  )
  const encodedHeader = base64Url(JSON.stringify({
    alg: 'EdDSA',
    typ: 'vc+jwt',
    kid: issuer.publicKey.id
  }))
  const encodedPayload = base64Url(JSON.stringify({
    iss: issuer.did,
    sub: credential.credentialSubject?.id || credential.id,
    jti: credential.id,
    iat: issuedAt,
    nbf: issuedAt,
    vc: credential
  }))
  const signingInput = `${encodedHeader}.${encodedPayload}`
  const signature = await issuer.key.signer().sign({ data: Buffer.from(signingInput) })
  return `${signingInput}.${base64Url(signature)}`
}

function formatUrls(credentialId) {
  return {
    json: `${credentialId}.json`,
    jsonld: `${credentialId}.jsonld`,
    openBadges: credentialId,
    png: `${credentialId}.png`,
    jwt: `${credentialId}.jwt`
  }
}

function isRevoked(issuerId, index) {
  return state.revoked.includes(`${issuerId}:${index}`)
}

async function buildStatusLists() {
  const lists = new Map()
  for (const issuerId of issuerDefinitions.map(({ id }) => id)) {
    const list = new BitstringStatusList({ length: statusListLength })
    for (const entry of state.revoked) {
      const [entryIssuer, entryIndex] = entry.split(':')
      if (entryIssuer === issuerId) list.setStatus(Number(entryIndex), true)
    }
    lists.set(issuerId, list)
  }
  return lists
}

async function statusListFor(issuer) {
  const id = `${publicBaseUrl}/api/status-lists/${issuer.id}`
  const credential = await createStatusListCredential({
    id,
    list: statusLists.get(issuer.id),
    statusPurpose: 'revocation',
    context: VC_BSL_VC_V1_CONTEXT
  })
  // The VCDM v1 status-list context expects issuer as an identifier; the
  // display name belongs in the issuer registry entry.
  credential.issuer = issuer.did
  credential.issuanceDate = new Date().toISOString()
  return signedCredential(credential, issuer)
}

function registryDocument() {
  return {
    version: '0.1.0',
    registry: Object.fromEntries(
      [...issuers.values()].map((issuer) => [issuer.did, {
        name: `${issuer.name} (DEMO)`,
        location: issuer.location,
        url: `${publicBaseUrl}/?issuer=${issuer.id}`
      }])
    )
  }
}

function issuerDirectory() {
  return [...issuers.values()].map(({ id, name, did, location }) => ({
    id,
    name: `${name} (DEMO)`,
    demo: true,
    did,
    location,
    didDocumentUrl: `${publicBaseUrl}/api/issuers/${id}/did.json`
  }))
}

function didDocumentFor(issuer) {
  return {
    '@context': [didContext, multikeyContext],
    id: issuer.did,
    verificationMethod: [issuer.publicKey],
    assertionMethod: [issuer.publicKey],
    authentication: [issuer.publicKey]
  }
}

function send(response, status, data, contentType = 'application/json; charset=utf-8') {
  const body = Buffer.isBuffer(data)
    ? data
    : contentType.includes('json') && !contentType.includes('jwt')
      ? Buffer.from(JSON.stringify(data))
      : Buffer.from(data)
  response.writeHead(status, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': process.env.ISSUER_DEMO_CORS_ORIGIN || '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': body.length
  })
  response.end(body)
}

async function bodyJson(request) {
  let body = ''
  for await (const chunk of request) {
    body += chunk
    if (body.length > 64 * 1024) throw new Error('Request body is too large.')
  }
  return JSON.parse(body || '{}')
}

function authorized(request) {
  const actual = request.headers.authorization?.replace(/^Bearer\s+/i, '') || ''
  const expectedBytes = Buffer.from(adminToken)
  const actualBytes = Buffer.from(actual)
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes)
}

function publicCredential(credential) {
  return credential
}

async function verifyCredential(credential) {
  const knownDIDRegistries = [{
    name: 'NDEAR Demo Issuers (DEMO ONLY)',
    type: 'dcc-legacy',
    url: `${publicBaseUrl}/api/registry.json`
  }]
  const response = await import('@digitalcredentials/verifier-core')
  return response.verifyCredential({ credential, knownDIDRegistries })
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === 'OPTIONS') return send(response, 204, '')
    const url = new URL(request.url, publicBaseUrl)
    const route = url.pathname

    if (request.method === 'GET' && route === '/') {
      const html = await readFile(path.join(directory, 'index.html'), 'utf8')
      return send(response, 200, html, 'text/html; charset=utf-8')
    }
    if (request.method === 'GET' && route === '/api/issuers') {
      return send(response, 200, issuerDirectory())
    }
    if (request.method === 'GET' && route === '/api/registry.json') {
      return send(response, 200, registryDocument())
    }
    if (request.method === 'GET' && route === '/api/qr.svg') {
      const text = url.searchParams.get('text') || ''
      if (text.length > 2048) return send(response, 400, { error: 'QR payload is too long.' })
      return send(response, 200, await QRCode.toString(text, { type: 'svg', margin: 1 }), 'image/svg+xml; charset=utf-8')
    }

    const didRoute = /^\/api\/issuers\/([^/]+)\/did\.json$/.exec(route)
    if (request.method === 'GET' && didRoute) {
      const issuer = issuers.get(didRoute[1])
      return issuer
        ? send(response, 200, didDocumentFor(issuer))
        : send(response, 404, { error: 'Unknown issuer.' })
    }

    const statusRoute = /^\/api\/status-lists\/([^/]+)$/.exec(route)
    if (request.method === 'GET' && statusRoute) {
      const issuer = issuers.get(statusRoute[1])
      return issuer
        ? send(response, 200, await statusListFor(issuer))
        : send(response, 404, { error: 'Unknown issuer.' })
    }

    const credentialRoute = /^\/api\/credentials\/([\w-]+)(?:\.(json|jsonld|jwt|png))?$/.exec(route)
    if (request.method === 'GET' && credentialRoute) {
      const record = state.credentials.find(({ credential }) => credential.id.endsWith(credentialRoute[1]))
      if (!record) return send(response, 404, { error: 'Credential not found.' })
      const format = credentialRoute[2]
      if (format === 'png') {
        return send(response, 200, bakeOpenBadgePng(record.credential), 'image/png')
      }
      if (format === 'jwt') {
        const issuer = issuers.get(record.issuerId)
        return send(response, 200, await jwtFor(record.credential, issuer), 'application/vc+jwt')
      }
      const type = format === 'json'
        ? 'application/json; charset=utf-8'
        : 'application/ld+json; charset=utf-8'
      return send(response, 200, publicCredential(record.credential), type)
    }

    const verifyRoute = /^\/api\/verify\/([\w-]+)$/.exec(route)
    if (request.method === 'GET' && verifyRoute) {
      const record = state.credentials.find(({ credential }) => credential.id.endsWith(verifyRoute[1]))
      if (!record) return send(response, 404, { error: 'Credential not found.' })
      const result = await verifyCredential(record.credential)
      const log = result.log ?? []
      return send(response, 200, {
        credential: record.credential,
        verified: result.verified === false
          ? false
          : log.length > 0 && log.every((check) => check.valid),
        log,
        revoked: isRevoked(record.issuerId, record.statusListIndex)
      })
    }

    if (request.method === 'POST' && route === '/api/verify') {
      const input = await bodyJson(request)
      const credential = input.credential ?? input
      if (
        !credential ||
        typeof credential !== 'object' ||
        !Array.isArray(credential.type) ||
        !credential.type.includes('VerifiableCredential')
      ) {
        return send(response, 400, {
          error: 'Submit a W3C Verifiable Credential JSON object.'
        })
      }
      const result = await verifyCredential(credential)
      const log = result.log ?? []
      const verified = result.verified === false
        ? false
        : log.length > 0 && log.every((check) => check.valid)
      const record = state.credentials.find(
        ({ credential: stored }) => stored.id === credential.id
      )
      return send(response, 200, {
        credentialId: credential.id ?? null,
        verified,
        checks: log,
        revoked: record
          ? isRevoked(record.issuerId, record.statusListIndex)
          : null
      })
    }

    if (request.method === 'POST' && route === '/api/credentials') {
      if (!authorized(request)) return send(response, 401, { error: 'Issuer admin token required.' })
      const input = await bodyJson(request)
      const issuer = issuers.get(input.issuerId)
      if (!issuer) return send(response, 400, { error: 'Choose one of the three demo issuers.' })
      if (typeof input.learnerName !== 'string' || input.learnerName.trim().length < 2) {
        return send(response, 400, { error: 'Learner name must have at least two characters.' })
      }
      if (typeof input.achievementName !== 'string' || input.achievementName.trim().length < 2) {
        return send(response, 400, { error: 'Achievement name must have at least two characters.' })
      }
      const index = state.nextIndex[issuer.id] ?? 0
      if (index >= statusListLength) return send(response, 507, { error: 'Issuer status list is full.' })
      state.nextIndex[issuer.id] = index + 1
      const id = `${publicBaseUrl}/api/credentials/${randomUUID()}`
      const issuanceDate = new Date().toISOString()
      const credential = await signedCredential({
        '@context': [vcContext, obContext, VC_BSL_VC_V1_CONTEXT[1]],
        id,
        type: ['VerifiableCredential', 'OpenBadgeCredential'],
        name: input.achievementName.trim(),
        issuer: { id: issuer.did, name: issuer.name },
        validFrom: issuanceDate,
        credentialSubject: {
          type: ['AchievementSubject'],
          name: input.learnerName.trim(),
          achievement: {
            type: ['Achievement'],
            name: input.achievementName.trim(),
            description: typeof input.description === 'string' ? input.description.trim() : '',
            criteria: {
              narrative: 'Issued by a demo issuer for the NDEAR wallet project.'
            }
          }
        },
        credentialStatus: {
          id: `${publicBaseUrl}/api/status-lists/${issuer.id}#${index}`,
          type: 'BitstringStatusListEntry',
          statusPurpose: 'revocation',
          statusListIndex: String(index),
          statusListCredential: `${publicBaseUrl}/api/status-lists/${issuer.id}`
        }
      }, issuer)
      state.credentials.push({ credential, issuerId: issuer.id, statusListIndex: index })
      await saveJson(statePath, state)
      const jwt = await jwtFor(credential, issuer)
      const formats = formatUrls(id)
      return send(response, 201, {
        credential,
        jwt,
        formats,
        credentialUrl: id,
        walletLink: `ndear://certificate/import?url=${encodeURIComponent(id)}`,
        verifyUrl: `${publicBaseUrl}/?credential=${encodeURIComponent(id)}`
      })
    }

    const revokeRoute = /^\/api\/credentials\/([\w-]+)\/revoke$/.exec(route)
    if (request.method === 'POST' && revokeRoute) {
      if (!authorized(request)) return send(response, 401, { error: 'Issuer admin token required.' })
      const record = state.credentials.find(({ credential }) => credential.id.endsWith(revokeRoute[1]))
      if (!record) return send(response, 404, { error: 'Credential not found.' })
      const key = `${record.issuerId}:${record.statusListIndex}`
      if (!state.revoked.includes(key)) state.revoked.push(key)
      statusLists.get(record.issuerId).setStatus(record.statusListIndex, true)
      await saveJson(statePath, state)
      return send(response, 200, { revoked: true, credentialId: record.credential.id })
    }

    return send(response, 404, { error: 'Route not found.' })
  } catch (error) {
    console.error('[issuer-demo]', error)
    return send(response, 500, { error: error instanceof Error ? error.message : 'Request failed.' })
  }
})

server.listen(port, host, () => {
  console.log(`NDEAR signed demo issuer running at ${publicBaseUrl}`)
  console.log('All three issuers are clearly labelled DEMO. Do not represent them as real institutions.')
  console.log(`Issuer admin token (keep local): ${adminToken}`)
  console.log('Private signing keys and issued demo credentials are stored under the ignored .issuer-demo-data directory.')
})
