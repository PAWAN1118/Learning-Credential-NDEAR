import type { IVerifiableCredential } from '@digitalcredentials/ssi'

const CREDLY_API = 'https://api.credly.com/api/v1/obi/v2'
const CREDLY_API_ALTERNATES = [
  'https://api.credly.com/v1/obi/v2',
  'https://www.credly.com/api/v1/obi/v2'
]
const BADGE_ID_PATTERN = /\/badges\/([0-9a-f-]{36})(?:\/public_url)?\/?$/i
const ASSERTION_ID_PATTERN = /\/obi\/v2\/badge_assertions\/([0-9a-f-]{36})\/?$/i

type JsonRecord = Record<string, unknown>

type CredlyRecord = {
  assertion: JsonRecord
  badgeClass: JsonRecord
  issuer: JsonRecord
  badgeClassUrl: string
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function includesType(value: unknown, expected: string): boolean {
  const types = Array.isArray(value) ? value : [value]
  return types.some(
    (type) =>
      typeof type === 'string' &&
      (type === expected ||
        type === expected.toLowerCase().replace('badge', '') ||
        type.endsWith(`#${expected}`) ||
        type.endsWith(`/${expected}`))
  )
}

function linkedDataId(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (!isRecord(value)) return undefined
  if (typeof value.id === 'string') return value.id
  return typeof value['@id'] === 'string' ? value['@id'] : undefined
}

function linkedDataType(value: JsonRecord): unknown {
  return value.type ?? value['@type']
}

function hasEmbeddedData(value: unknown): value is JsonRecord {
  return (
    isRecord(value) &&
    Object.keys(value).some((key) => key !== 'id' && key !== '@id')
  )
}

function isCredlyUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      (url.hostname === 'api.credly.com' || url.hostname === 'www.credly.com')
    )
  } catch {
    return false
  }
}

export function credlyBadgeUuidFor(
  credential: IVerifiableCredential
): string | undefined {
  const urls = [
    typeof credential.id === 'string' ? credential.id : undefined,
    ...(Array.isArray(credential.evidence)
      ? credential.evidence.flatMap((item) =>
          isRecord(item) && typeof item.id === 'string' ? [item.id] : []
        )
      : [])
  ].filter((value): value is string => typeof value === 'string')

  for (const value of urls) {
    if (!isCredlyUrl(value)) continue
    const match =
      BADGE_ID_PATTERN.exec(value) ?? ASSERTION_ID_PATTERN.exec(value)
    if (match) return match[1].toLowerCase()
  }
  return undefined
}

async function fetchCredlyJson(url: string): Promise<JsonRecord> {
  if (!isCredlyUrl(url)) throw new Error('Credly returned a non-Credly URL.')
  const response = await fetch(url, {
    headers: { Accept: 'application/ld+json, application/json' }
  })
  if (!response.ok) {
    throw new Error(`Credly returned HTTP ${response.status}.`)
  }
  const body: unknown = await response.json()
  if (!isRecord(body)) throw new Error('Credly returned invalid badge data.')
  return body
}

async function fetchCredlyAssertion(id: string): Promise<JsonRecord> {
  let lastError: unknown
  for (const baseUrl of [CREDLY_API, ...CREDLY_API_ALTERNATES]) {
    try {
      return await fetchCredlyJson(`${baseUrl}/badge_assertions/${id}`)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('Credly could not return this badge assertion.')
}

async function fetchCredlyRecord(id: string): Promise<CredlyRecord> {
  const assertion = await fetchCredlyAssertion(id)
  const assertionUrl = `${CREDLY_API}/badge_assertions/${id}`
  const assertionId = linkedDataId(assertion) ?? assertionUrl
  if (
    !isCredlyUrl(assertionId) ||
    !ASSERTION_ID_PATTERN.test(assertionId) ||
    !assertionId.endsWith(id)
  ) {
    throw new Error('Credly returned an assertion with a different ID.')
  }
  if (!includesType(linkedDataType(assertion), 'Assertion')) {
    throw new Error('Credly did not return an Open Badges assertion.')
  }
  const rawVerification = assertion.verification
  const verification = Array.isArray(rawVerification)
    ? rawVerification.find(isRecord)
    : rawVerification
  if (
    !isRecord(verification) ||
    !includesType(verification.type, 'HostedBadge')
  ) {
    throw new Error(
      `Credly assertion uses an unsupported verification type (${JSON.stringify(
        isRecord(verification) ? verification.type : (verification ?? 'missing')
      )}).`
    )
  }

  const badgeClassUrl = linkedDataId(assertion.badge)
  if (!badgeClassUrl || !isCredlyUrl(badgeClassUrl)) {
    throw new Error('Credly assertion is missing a valid badge-class URL.')
  }
  const badgeClass = hasEmbeddedData(assertion.badge)
    ? assertion.badge
    : await fetchCredlyJson(badgeClassUrl)
  const resolvedBadgeClassId = linkedDataId(badgeClass)
  if (resolvedBadgeClassId && resolvedBadgeClassId !== badgeClassUrl) {
    throw new Error('Credly returned a different badge class.')
  }

  const issuerUrl = linkedDataId(badgeClass.issuer)
  if (!issuerUrl || !isCredlyUrl(issuerUrl)) {
    throw new Error('Credly badge is missing a valid issuer URL.')
  }
  const issuer = hasEmbeddedData(badgeClass.issuer)
    ? badgeClass.issuer
    : await fetchCredlyJson(issuerUrl)
  if (linkedDataId(issuer) !== issuerUrl) {
    throw new Error('Credly returned an issuer with a different ID.')
  }
  return { assertion, badgeClass, issuer, badgeClassUrl }
}

function isoDate(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

function dateOnly(value: unknown): string | undefined {
  return isoDate(value)?.slice(0, 10)
}

function normalizedLabel(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Replace PDF-only details with the issuer-hosted Credly badge data when available. */
export async function enrichSapPdfCredential(
  credential: IVerifiableCredential
): Promise<IVerifiableCredential> {
  const id = credlyBadgeUuidFor(credential)
  if (!id) return credential

  try {
    const { assertion, badgeClass, issuer, badgeClassUrl } =
      await fetchCredlyRecord(id)
    const issuerName = typeof issuer.name === 'string' ? issuer.name : ''
    if (!/\bSAP\b/i.test(issuerName)) return credential
    const badgeName =
      typeof badgeClass.name === 'string'
        ? badgeClass.name
        : getAchievementName(credential)
    const assertionId = linkedDataId(assertion)
      ? (linkedDataId(assertion) as string)
      : `${CREDLY_API}/badge_assertions/${id}`
    const issuanceDate = isoDate(assertion.issuedOn)
    const expirationDate = isoDate(assertion.expires)
    const description =
      typeof badgeClass.description === 'string'
        ? badgeClass.description
        : getAchievementDescription(credential)
    const badgeEvidenceUrl =
      typeof assertionId === 'string'
        ? `https://www.credly.com/badges/${id}/public_url`
        : undefined

    return {
      ...credential,
      id: assertionId,
      type: ['VerifiableCredential', 'OpenBadgeCredential'],
      issuer: {
        id: linkedDataId(issuer) as string,
        name: issuerName,
        ...(typeof issuer.url === 'string' ? { url: issuer.url } : {}),
        ...(typeof issuer.image === 'string' ? { image: issuer.image } : {})
      },
      ...(issuanceDate ? { issuanceDate } : {}),
      ...(expirationDate ? { expirationDate } : {}),
      credentialSubject: {
        ...getCredentialSubject(credential),
        achievement: {
          name: badgeName,
          ...(description ? { description } : {})
        }
      },
      evidence: [
        ...(badgeEvidenceUrl
          ? [{ type: ['Evidence'], id: badgeEvidenceUrl, name: 'Credly badge' }]
          : []),
        {
          type: ['Evidence'],
          id: assertionId,
          name: 'Credly-hosted Open Badges assertion'
        }
      ],
      credlyAssertion: {
        assertionUrl: assertionId,
        badgeClassUrl,
        verificationType: 'HostedBadge'
      }
    } as unknown as IVerifiableCredential
  } catch (error) {
    console.warn(
      '[Credly] Could not load hosted SAP badge; keeping PDF details.',
      error
    )
    return credential
  }
}

function getCredentialSubject(credential: IVerifiableCredential): JsonRecord {
  return isRecord(credential.credentialSubject)
    ? credential.credentialSubject
    : {}
}

function getAchievementName(credential: IVerifiableCredential): string {
  const achievement = getCredentialSubject(credential).achievement
  return isRecord(achievement) && typeof achievement.name === 'string'
    ? achievement.name
    : ''
}

function getAchievementDescription(
  credential: IVerifiableCredential
): string | undefined {
  const achievement = getCredentialSubject(credential).achievement
  return isRecord(achievement) && typeof achievement.description === 'string'
    ? achievement.description
    : undefined
}

export type CredlyVerification = {
  verified: boolean
  recordAvailable: boolean
  issuerConfirmed: boolean
  revoked?: boolean
  issuerName?: string
  issuerUrl?: string
  reason?: string
  expires?: string
}

/** Live verification against Credly's official hosted Open Badges assertion. */
export async function verifyCredlyCredential(
  credential: IVerifiableCredential
): Promise<CredlyVerification | undefined> {
  const id = credlyBadgeUuidFor(credential)
  if (!id) return undefined
  try {
    const { assertion, badgeClass, issuer } = await fetchCredlyRecord(id)
    const issuerName = typeof issuer.name === 'string' ? issuer.name : ''
    const issuerUrl = typeof issuer.url === 'string' ? issuer.url : undefined
    const expiry = isoDate(assertion.expires)
    const expired = expiry ? new Date(expiry).getTime() <= Date.now() : false
    const assertionRevoked = assertion.revoked === true
    const badgeName =
      typeof badgeClass.name === 'string' ? badgeClass.name.trim() : ''
    const credentialName = getAchievementName(credential).trim()
    const matchesTitle =
      credentialName.length > 0 &&
      normalizedLabel(credentialName) === normalizedLabel(badgeName)
    const credentialIssue = dateOnly(credential.issuanceDate)
    const credentialExpiry = dateOnly(credential.expirationDate)
    const assertionIssue = dateOnly(assertion.issuedOn)
    const assertionExpiry = dateOnly(assertion.expires)
    const matchesDates =
      !!assertionIssue &&
      (!credentialIssue || credentialIssue === assertionIssue) &&
      (!assertionExpiry ||
        !credentialExpiry ||
        credentialExpiry === assertionExpiry)
    const hasRecipient =
      isRecord(assertion.recipient) &&
      typeof assertion.recipient.identity === 'string'
    const issuerConfirmed = /\bSAP\b/i.test(issuerName)
    const valid =
      issuerConfirmed &&
      hasRecipient &&
      matchesDates &&
      !expired &&
      !assertionRevoked &&
      matchesTitle
    return {
      verified: valid,
      recordAvailable: true,
      issuerConfirmed,
      issuerName,
      issuerUrl,
      ...(expiry ? { expires: expiry } : {}),
      revoked: assertionRevoked,
      ...(!valid
        ? {
            reason: assertionRevoked
              ? 'Credly reports that this badge has been revoked.'
              : expired
                ? 'Credly reports that this badge has expired.'
                : !issuerConfirmed
                  ? `Credly lists the issuer as ${issuerName || 'unknown'}, not SAP.`
                  : !hasRecipient
                    ? 'Credly’s record is missing its recipient identity.'
                    : !matchesTitle
                      ? `The certificate title “${credentialName || 'missing'}” does not match Credly’s badge “${badgeName || 'missing'}”.`
                      : !matchesDates
                        ? 'The certificate issue or expiry date does not match Credly’s record.'
                        : 'Credly returned an incomplete badge assertion.'
          }
        : {})
    }
  } catch (error) {
    return {
      verified: false,
      recordAvailable: false,
      issuerConfirmed: false,
      reason:
        error instanceof Error
          ? error.message
          : 'Credly could not verify this badge right now.'
    }
  }
}
