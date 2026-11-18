import { IVerifiableCredential } from '@digitalcredentials/ssi'
import {
  udemyCertificateCredentialFromText,
  udemyCertificateIdFromText,
  udemyCertificateTextFromPdfBytes
} from './udemyCertificate'

type RecordResult = {
  available: boolean
  verified: boolean
  reason: string
  certificateId?: string
}

function certificateIdFrom(
  credential: IVerifiableCredential
): string | undefined {
  const evidence = Array.isArray(credential.evidence) ? credential.evidence : []
  const candidates = [
    typeof credential.id === 'string' ? credential.id : '',
    ...evidence.map((item) =>
      typeof item === 'object' &&
      item &&
      'id' in item &&
      typeof item.id === 'string'
        ? item.id
        : ''
    )
  ]
  for (const candidate of candidates) {
    const match = /\bUC-[a-f0-9]{8}-[a-f0-9-]{20,}\b/i.exec(candidate)
    if (match) return match[0]
  }
  return undefined
}

function normalized(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Confirms this certificate against Udemy's publicly hosted certificate PDF.
 * Udemy completion certificates are records, not cryptographically signed VCs.
 */
export async function verifyUdemyCredential(
  credential: IVerifiableCredential
): Promise<RecordResult | undefined> {
  const issuerId =
    typeof credential.issuer === 'string'
      ? credential.issuer
      : credential.issuer?.id
  if (!issuerId) return undefined
  try {
    if (!/(^|\.)udemy\.com$/i.test(new URL(issuerId).hostname)) return undefined
  } catch {
    return undefined
  }

  const certificateId = certificateIdFrom(credential)
  if (!certificateId) {
    return {
      available: false,
      verified: false,
      reason:
        'The Udemy certificate ID is missing or has an unsupported format.'
    }
  }
  const subject = Array.isArray(credential.credentialSubject)
    ? credential.credentialSubject[0]
    : credential.credentialSubject
  const title = subject?.achievement?.name
  if (typeof title !== 'string' || !title.trim()) {
    return {
      available: false,
      verified: false,
      reason: 'The course title is missing from this Udemy certificate.'
    }
  }

  try {
    const certificateUrl = `https://udemy-certificate.s3.amazonaws.com/pdf/${certificateId}.pdf`
    const response = await fetch(certificateUrl, {
      headers: { Accept: 'application/pdf' }
    })
    if (!response.ok) {
      return {
        available: false,
        verified: false,
        certificateId,
        reason: `Udemy returned HTTP ${response.status} for this certificate.`
      }
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    const publicText = await udemyCertificateTextFromPdfBytes(
      bytes,
      certificateId
    )
    const publicId = udemyCertificateIdFromText(publicText)
    const publicCredential = udemyCertificateCredentialFromText(
      publicText,
      certificateId
    )
    const publicSubject = Array.isArray(publicCredential?.credentialSubject)
      ? publicCredential.credentialSubject[0]
      : publicCredential?.credentialSubject
    const publicTitle = publicSubject?.achievement?.name
    const titleMatches =
      typeof publicTitle === 'string' &&
      normalized(publicTitle) === normalized(title)
    const recipient = subject.name
    const nameMatches =
      typeof recipient !== 'string' ||
      typeof publicSubject?.name !== 'string' ||
      normalized(recipient) === normalized(publicSubject.name)
    const verified = publicId === certificateId && titleMatches && nameMatches
    return {
      available: true,
      verified,
      certificateId,
      reason: verified
        ? 'Udemy’s public certificate record matches this ID, course title, and recipient.'
        : 'Udemy’s public certificate PDF did not confirm this ID and course details together.'
    }
  } catch {
    return {
      available: false,
      verified: false,
      certificateId,
      reason: 'Udemy’s public certificate record could not be reached.'
    }
  }
}
