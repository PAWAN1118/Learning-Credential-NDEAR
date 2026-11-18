import type { IVerifiableCredential } from '@digitalcredentials/ssi'

const CERTFORGE_HOSTS = new Set([
  'certforge.intelliforge.tech',
  'api.certforge.intelliforge.tech'
])
const API_ORIGIN = 'https://api.certforge.intelliforge.tech'
const CERTFORGE_ID_PATTERN = /^CF-\d{4}-[A-Z0-9]{6,16}$/i
const PRINTED_CERTFORGE_ID_PATTERN = /\bCF-\d{4}-[A-Z0-9]{6,16}\b/i

export function certForgeIdPrintedInText(text: string): string | undefined {
  return PRINTED_CERTFORGE_ID_PATTERN.exec(text)?.[0].toUpperCase()
}

function credentialIdFromPath(pathname: string): string | undefined {
  const match =
    /\/(?:verify|credentials)\/([^/]+)(?:\/badge\.json)?\/?$/i.exec(pathname) ??
    /\/certificate\/([^/]+)\/(?:verify|download)\/?$/i.exec(pathname)
  const id = match?.[1] ? decodeURIComponent(match[1]) : undefined
  return id && CERTFORGE_ID_PATTERN.test(id) ? id.toUpperCase() : undefined
}

export function certForgeCredentialIdFrom(input: string): string | undefined {
  const trimmed = input.trim()
  if (CERTFORGE_ID_PATTERN.test(trimmed)) return trimmed.toUpperCase()

  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'https:' || !CERTFORGE_HOSTS.has(url.hostname)) {
      return undefined
    }
    const pathId = credentialIdFromPath(url.pathname)
    if (pathId) return pathId
    for (const key of ['credential_id', 'credentialId', 'cert_id', 'id']) {
      const queryId = url.searchParams.get(key)
      if (queryId && CERTFORGE_ID_PATTERN.test(queryId)) {
        return queryId.toUpperCase()
      }
    }
  } catch {
    return undefined
  }
  return undefined
}

export function isCertForgeHomepage(input: string): boolean {
  try {
    const url = new URL(input.trim())
    return (
      url.protocol === 'https:' &&
      url.hostname === 'certforge.intelliforge.tech' &&
      !certForgeCredentialIdFrom(input)
    )
  } catch {
    return false
  }
}

export function certForgeCredentialIdFor(
  credential: IVerifiableCredential
): string | undefined {
  return typeof credential.id === 'string'
    ? certForgeCredentialIdFrom(credential.id)
    : undefined
}

function responseData(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value
  }
  const record = value as Record<string, unknown>
  if (record.success === false) {
    const message =
      typeof record.error === 'object' &&
      record.error !== null &&
      'message' in record.error &&
      typeof record.error.message === 'string'
        ? record.error.message
        : 'CertForge could not find that certificate ID.'
    throw new Error(message)
  }
  return 'data' in record ? record.data : value
}

function isCredential(value: unknown): value is IVerifiableCredential {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const credential = value as Record<string, unknown>
  return (
    Array.isArray(credential.type) &&
    credential.type.includes('VerifiableCredential') &&
    (typeof credential.issuer === 'string' ||
      (typeof credential.issuer === 'object' &&
        credential.issuer !== null &&
        'id' in credential.issuer)) &&
    typeof credential.credentialSubject === 'object' &&
    credential.credentialSubject !== null
  )
}

function isAuthenticResult(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const result = value as Record<string, unknown>
  const status =
    typeof result.status === 'string' ? result.status.toLowerCase() : ''
  const revoked = result.revoked === true || status === 'revoked'
  const acceptedStatus = ['valid', 'verified', 'authentic'].includes(status)
  return (
    !revoked &&
    (result.valid === true ||
      result.verified === true ||
      result.is_valid === true ||
      acceptedStatus)
  )
}

export type CertForgeVerification = {
  verified: boolean
  revoked?: boolean
}

export async function verifyCertForgeCredential(
  credential: IVerifiableCredential
): Promise<CertForgeVerification | undefined> {
  const id = certForgeCredentialIdFor(credential)
  if (!id) return undefined
  const response = await fetch(
    `${API_ORIGIN}/api/v1/verify/${encodeURIComponent(id)}`,
    { headers: { Accept: 'application/json' } }
  )
  if (!response.ok) {
    throw new Error(
      response.status === 404
        ? 'CertForge did not find this credential ID.'
        : `CertForge verification returned HTTP ${response.status}.`
    )
  }
  const result = responseData(await response.json())
  const record =
    typeof result === 'object' && result !== null && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : undefined
  const status =
    typeof record?.status === 'string' ? record.status.toLowerCase() : ''
  return {
    verified: isAuthenticResult(result),
    ...(typeof record?.revoked === 'boolean'
      ? { revoked: record.revoked }
      : status === 'revoked'
        ? { revoked: true }
        : {})
  }
}

/** Fetch and verify a public CertForge badge by its printed certificate ID. */
export async function fetchCertForgeCredential(
  id: string
): Promise<IVerifiableCredential> {
  const normalizedId = id.trim().toUpperCase()
  if (!CERTFORGE_ID_PATTERN.test(normalizedId)) {
    throw new Error(
      'Enter the CertForge ID printed on the certificate (for example, CF-2026-XXXXXXXX).'
    )
  }

  const encodedId = encodeURIComponent(normalizedId)
  const verificationResponse = await fetch(
    `${API_ORIGIN}/api/v1/verify/${encodedId}`,
    { headers: { Accept: 'application/json' } }
  )
  if (!verificationResponse.ok) {
    throw new Error(
      verificationResponse.status === 404
        ? 'CertForge did not find a certificate with that ID.'
        : `CertForge verification returned HTTP ${verificationResponse.status}.`
    )
  }
  const verification = responseData(await verificationResponse.json())
  if (!isAuthenticResult(verification)) {
    throw new Error(
      'CertForge did not confirm this certificate as valid. It was not added.'
    )
  }

  const badgeResponse = await fetch(
    `${API_ORIGIN}/credentials/${encodedId}/badge.json`,
    { headers: { Accept: 'application/ld+json, application/json' } }
  )
  if (!badgeResponse.ok) {
    throw new Error(
      badgeResponse.status === 404
        ? 'CertForge verified the ID but did not provide its Open Badges credential.'
        : `CertForge could not load the badge details (HTTP ${badgeResponse.status}).`
    )
  }
  const badge = responseData(await badgeResponse.json())
  const candidate =
    typeof badge === 'object' && badge !== null && 'credential' in badge
      ? badge.credential
      : badge
  if (!isCredential(candidate)) {
    throw new Error(
      'CertForge returned data that is not an Open Badges credential.'
    )
  }
  return candidate
}
