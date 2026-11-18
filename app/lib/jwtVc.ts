import * as Ed25519Multikey from '@digitalcredentials/ed25519-multikey'
import { IVerifiableCredential } from '@digitalcredentials/ssi'

export const JWT_VC_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

export function isCompactJwt(text: string): boolean {
  return JWT_VC_PATTERN.test(text.trim())
}

function bytesFromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const padLength = (4 - (padded.length % 4)) % 4
  const binary = globalThis.atob
    ? globalThis.atob(padded + '='.repeat(padLength))
    : Buffer.from(padded + '='.repeat(padLength), 'base64').toString('binary')
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function textFromBytes(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

function didKeyMultibase(did: string): string {
  return did.startsWith('did:key:') ? did.slice('did:key:'.length) : did
}

/**
 * Unwrap a compact EdDSA JWT Verifiable Credential and check its envelope
 * signature. The inner `vc` claim is returned for Data Integrity / registry
 * verification by the existing verifier.
 */
export async function credentialFromJwtVc(
  token: string
): Promise<IVerifiableCredential> {
  const trimmed = token.trim()
  const parts = trimmed.split('.')
  if (parts.length !== 3 || !isCompactJwt(trimmed)) {
    throw new Error('JWT verifiable credential is malformed.')
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts
  let header: { alg?: string; kid?: string; typ?: string }
  let payload: {
    iss?: string
    vc?: IVerifiableCredential
  }
  try {
    header = JSON.parse(textFromBytes(bytesFromBase64Url(encodedHeader)))
    payload = JSON.parse(textFromBytes(bytesFromBase64Url(encodedPayload)))
  } catch {
    throw new Error('JWT verifiable credential could not be decoded.')
  }

  if (header.alg !== 'EdDSA') {
    throw new Error('Only EdDSA JWT verifiable credentials are supported.')
  }

  const credential = payload.vc
  if (
    !credential ||
    !Array.isArray(credential.type) ||
    !credential.type.includes('VerifiableCredential')
  ) {
    throw new Error('JWT does not contain a verifiable credential.')
  }

  const issuerDid =
    typeof payload.iss === 'string'
      ? payload.iss
      : typeof credential.issuer === 'string'
        ? credential.issuer
        : credential.issuer?.id
  if (typeof issuerDid !== 'string' || !issuerDid.startsWith('did:key:')) {
    throw new Error('JWT issuer must be a did:key identifier.')
  }

  const publicKeyMultibase = didKeyMultibase(issuerDid)
  const keyId = header.kid || `${issuerDid}#${publicKeyMultibase}`
  const key = await Ed25519Multikey.from({
    id: keyId,
    controller: issuerDid,
    publicKeyMultibase
  })
  const signingInput = new TextEncoder().encode(
    `${encodedHeader}.${encodedPayload}`
  )
  let valid = false
  try {
    valid = await key.verifier().verify({
      data: signingInput,
      signature: bytesFromBase64Url(encodedSignature)
    })
  } catch {
    valid = false
  }
  if (!valid) {
    throw new Error('JWT verifiable credential signature is invalid.')
  }

  return credential
}
