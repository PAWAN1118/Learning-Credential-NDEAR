import qs from 'query-string'

import { CredentialRequestParams } from './credentialRequest'

import { CredentialRecordRaw } from '../model'

import { IVerifiableCredential } from '@digitalcredentials/ssi'
import { getSubject } from './credentialDisplay/shared'
import { isDeepLink } from './walletRequestApi'
import { credentialsFromVpqr } from './credentialsFromVpqr'
import { credentialsFromPresentation } from './credentialsFromPresentation'
import { isVerifiableCredential, isVerifiablePresentation } from './validate'
import { credentialFromJwtVc, isCompactJwt } from './jwtVc'
import { inflate } from 'pako'
import { enrichSapPdfCredential } from './credly'
import {
  certForgeCredentialIdFrom,
  fetchCertForgeCredential,
  isCertForgeHomepage
} from './certForge'
import {
  udemyCertificateCredentialFromText,
  udemyCertificateIdFromText,
  udemyCertificateTextFromPdfBytes
} from './udemyCertificate'

export const regexPattern = {
  vpqr: /^VP1-[A-Z|0-9]+/,
  url: /^https?:\/\/.+/,
  json: /^{.*}$/s,
  jwt: /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
}

export function isLegacyCredentialRequest(url: string): boolean {
  if (!isDeepLink(url)) {
    return false
  }
  // TODO: Use native URL object instead of 'qs'
  const queryParams = qs.parse(url.split('?')[1])
  return 'vc_request_url' in queryParams && 'issuer' in queryParams
}

export function legacyRequestParamsFromUrl(
  url: string
): CredentialRequestParams {
  const params = qs.parse(url.split('?')[1])
  return params as CredentialRequestParams
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function isPngBytes(bytes: Uint8Array): boolean {
  return PNG_MAGIC.every((byte, index) => bytes[index] === byte)
}

export function credentialTextFromPng(bytes: Uint8Array): string {
  const decodedString = new TextDecoder('utf-8').decode(bytes)
  const keyword = 'openbadgecredential'
  const keywordIndex = decodedString.indexOf(keyword)
  if (keywordIndex === -1) {
    throw new Error('PNG badge does not contain an Open Badge credential.')
  }
  const objectStart = decodedString.indexOf('{', keywordIndex + keyword.length)
  if (objectStart === -1) {
    throw new Error('PNG badge credential JSON is missing.')
  }
  let braceCount = 0
  let inString = false
  let escaped = false
  let objectEnd = objectStart
  while (objectEnd < decodedString.length) {
    const char = decodedString[objectEnd]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
    } else if (char === '"') {
      inString = true
    } else if (char === '{') {
      braceCount += 1
    } else if (char === '}') {
      braceCount -= 1
      if (braceCount === 0) break
    }
    objectEnd += 1
  }
  if (braceCount !== 0)
    throw new Error('PNG badge credential JSON is incomplete.')
  const objectString = decodedString.slice(objectStart, objectEnd + 1)
  JSON.parse(objectString)
  return objectString
}

async function credentialsFromJson(
  text: string
): Promise<IVerifiableCredential[]> {
  const data = JSON.parse(text)

  if (data?.vp && isVerifiablePresentation(data.vp)) {
    return credentialsFromPresentation(data.vp)
  }

  if (isVerifiablePresentation(data)) {
    return credentialsFromPresentation(data)
  }

  if (isVerifiableCredential(data)) {
    return [await enrichSapPdfCredential(data)]
  }

  throw new Error('Credential(s) could not be decoded from the JSON.')
}

/**
 * Some Open Badges hosts publish a badge page instead of putting the VC
 * directly in the QR. Accept the common machine-readable forms used by those
 * pages, while refusing to treat ordinary page text as a credential.
 */
export function credentialRepresentationsFromHtml(html: string): string[] {
  const representations: string[] = []
  const scriptPattern =
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi
  let scriptMatch: RegExpExecArray | null
  while ((scriptMatch = scriptPattern.exec(html))) {
    const jsonText = scriptMatch[1].trim()
    if (jsonText) representations.push(jsonText)
  }

  // Open Badge hosts may expose a signed VC as an alternate representation.
  const linkPattern = /<link\b[^>]*>/gi
  let linkMatch: RegExpExecArray | null
  while ((linkMatch = linkPattern.exec(html))) {
    const tag = linkMatch[0]
    const rel = /\brel=["']([^"']+)["']/i.exec(tag)?.[1] ?? ''
    const type = /\btype=["']([^"']+)["']/i.exec(tag)?.[1] ?? ''
    const href = /\bhref=["']([^"']+)["']/i.exec(tag)?.[1]
    if (
      href &&
      rel.toLowerCase().split(/\s+/).includes('alternate') &&
      /(?:application\/(?:vc\+json|ld\+json|vc\+jwt)|application\/json)/i.test(
        type
      )
    ) {
      representations.push(`__credential_url__:${href}`)
    }
  }
  return representations
}

export function learningCertificateUrlPrintedInText(
  text: string
): string | undefined {
  const match =
    /https?:\/\/(?:www\.)?(?:udemy\.com\/certificate\/[^\s<>"')]+|ude\.my\/[A-Z0-9-]+|credly\.com\/badges\/[0-9a-f-]+(?:\/public_url)?)/i.exec(
      text
    )
  if (match) return match[0].replace(/[.,;]+$/, '')

  // OCR can split the UC prefix or confuse O/I with 0/1 in the UUID.
  const certificateId = udemyCertificateIdFromText(text)
  return certificateId
    ? `https://www.udemy.com/certificate/${certificateId}/`
    : undefined
}

function latin1(bytes: Uint8Array): string {
  const chunks: string[] = []
  const size = 0x8000
  for (let index = 0; index < bytes.length; index += size) {
    chunks.push(String.fromCharCode(...bytes.subarray(index, index + size)))
  }
  return chunks.join('')
}

function pdfHexText(hex: string): string {
  const normalized = hex.replace(/\s+/g, '')
  const evenHex = normalized.length % 2 ? `${normalized}0` : normalized
  const bytes = new Uint8Array(evenHex.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = parseInt(evenHex.slice(index * 2, index * 2 + 2), 16)
  }
  try {
    return new TextDecoder('utf-8').decode(bytes)
  } catch {
    return latin1(bytes)
  }
}

function pdfTextOperators(content: string): string[] {
  const lines: string[] = []
  const textBlock = /\bBT\b([\s\S]*?)\bET\b/g
  let block: RegExpExecArray | null
  while ((block = textBlock.exec(content))) {
    const operators =
      /\[[\s\S]*?\]\s*TJ|<([\da-f\s]+)>\s*Tj|\(((?:\\.|[^)])*)\)\s*Tj/gi
    let operator: RegExpExecArray | null
    while ((operator = operators.exec(block[1]))) {
      const value = operator[0]
      const strings: string[] = []
      const hexStrings = /<([\da-f\s]+)>/gi
      let hex: RegExpExecArray | null
      while ((hex = hexStrings.exec(value))) strings.push(pdfHexText(hex[1]))
      if (strings.length > 0) {
        lines.push(strings.join(''))
      } else {
        const literal = /\(((?:\\.|[^)])*)\)\s*Tj/i.exec(value)?.[1]
        if (literal) {
          lines.push(
            literal
              .replace(/\\([()\\])/g, '$1')
              .replace(/\\n/g, '\n')
              .replace(/\\r/g, '\r')
          )
        }
      }
    }
  }
  return lines
}

/** Extract selectable text from common Flate-compressed PDF content streams. */
export function textFromPdfBytes(bytes: Uint8Array): string {
  const raw = latin1(bytes)
  if (!raw.startsWith('%PDF-')) return ''
  const extracted: string[] = []
  let streamIndex = 0
  while ((streamIndex = raw.indexOf('stream', streamIndex)) !== -1) {
    const dictionaryStart = raw.lastIndexOf('<<', streamIndex)
    const dictionaryEnd = raw.lastIndexOf('>>', streamIndex)
    const dictionary =
      dictionaryStart >= 0 && dictionaryEnd > dictionaryStart
        ? raw.slice(dictionaryStart, dictionaryEnd + 2)
        : ''
    const dataStartCandidate = streamIndex + 6
    const dataStart = raw.startsWith('\r\n', dataStartCandidate)
      ? dataStartCandidate + 2
      : raw.startsWith('\n', dataStartCandidate)
        ? dataStartCandidate + 1
        : dataStartCandidate
    const dataEnd = raw.indexOf('endstream', dataStart)
    if (dataEnd < 0) break
    let streamBytes = bytes.subarray(dataStart, dataEnd)
    while (
      streamBytes.length > 0 &&
      (streamBytes.at(-1) === 10 || streamBytes.at(-1) === 13)
    ) {
      streamBytes = streamBytes.subarray(0, streamBytes.length - 1)
    }
    try {
      const content = /\/FlateDecode\b/.test(dictionary)
        ? latin1(inflate(streamBytes))
        : latin1(streamBytes)
      if (/\bBT\b/.test(content) && /\bET\b/.test(content)) {
        extracted.push(...pdfTextOperators(content))
      }
    } catch {
      // Ignore non-text or unsupported PDF streams.
    }
    streamIndex = dataEnd + 9
  }
  return extracted.join('\n').replace(/\0/g, '').trim()
}

export function sapCertificateCredentialFromPdfText(
  text: string
): IVerifiableCredential | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const title = lines.find((line) => /^SAP Certified\s*[-–]/i.test(line))
  const badgeUrl = learningCertificateUrlPrintedInText(text)
  if (!title || !badgeUrl || !/credly\.com\/badges\//i.test(badgeUrl)) {
    return undefined
  }
  const issuedText = /Issued on:\s*([A-Za-z]{3}\s+\d{1,2},\s+\d{4})/i.exec(
    text
  )?.[1]
  const expiresText = /Expires on:\s*([A-Za-z]{3}\s+\d{1,2},\s+\d{4})/i.exec(
    text
  )?.[1]
  const dateToIso = (value?: string) => {
    if (!value) return undefined
    const parts = /^([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4})$/.exec(value)
    if (!parts) return undefined
    const month = [
      'jan',
      'feb',
      'mar',
      'apr',
      'may',
      'jun',
      'jul',
      'aug',
      'sep',
      'oct',
      'nov',
      'dec'
    ].indexOf(parts[1].toLowerCase())
    if (month < 0) return undefined
    return new Date(
      Date.UTC(Number(parts[3]), month, Number(parts[2]))
    ).toISOString()
  }
  const badgeIndex = lines.findIndex((line) => line.includes(badgeUrl))
  const holder = badgeIndex > 0 ? lines[badgeIndex - 1] : undefined
  const descriptionStart = lines.findIndex((line) =>
    /This certification verifies/i.test(line)
  )
  let description: string | undefined
  if (descriptionStart >= 0) {
    const descriptionLines: string[] = []
    for (const line of lines.slice(descriptionStart)) {
      if (/^[A-Z][A-Z\s.'-]{5,}$/.test(line)) break
      descriptionLines.push(line)
    }
    description = descriptionLines.join(' ')
  }

  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: badgeUrl,
    type: ['VerifiableCredential', 'LearningAchievementCredential'],
    issuer: { id: 'https://learning.sap.com', name: 'SAP' },
    ...(dateToIso(issuedText) ? { issuanceDate: dateToIso(issuedText) } : {}),
    ...(dateToIso(expiresText)
      ? { expirationDate: dateToIso(expiresText) }
      : {}),
    credentialSubject: {
      ...(holder ? { name: holder } : {}),
      achievement: { name: title, ...(description ? { description } : {}) }
    },
    evidence: [{ type: ['Evidence'], id: badgeUrl, name: 'SAP Credly badge' }]
  } as unknown as IVerifiableCredential
}

function credentialLooksLikeHtml(text: string, contentType: string): boolean {
  return (
    /text\/html|application\/xhtml\+xml/i.test(contentType) ||
    /^<!doctype\s+html|^<html\b/i.test(text)
  )
}

function htmlMetadata(html: string, key: string): string | undefined {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const patterns = [
    new RegExp(
      `<meta\\b[^>]*(?:property|name)=["']${escapedKey}["'][^>]*content=["']([^"']+)["'][^>]*>`,
      'i'
    ),
    new RegExp(
      `<meta\\b[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']${escapedKey}["'][^>]*>`,
      'i'
    )
  ]
  const raw = patterns.map((pattern) => pattern.exec(html)?.[1]).find(Boolean)
  return raw
    ?.replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .trim()
}

function unverifiedLearningCertificateFromHtml(
  html: string,
  url: string
): IVerifiableCredential | undefined {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return undefined
  }
  const udemy =
    host === 'udemy.com' || host.endsWith('.udemy.com') || host === 'ude.my'
  const credly = host === 'credly.com' || host.endsWith('.credly.com')
  if (!udemy && !credly) return undefined

  const pageTitle =
    htmlMetadata(html, 'og:title') ??
    /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim()
  const description =
    htmlMetadata(html, 'og:description') ?? htmlMetadata(html, 'description')
  if (!pageTitle && !description) return undefined

  const title = (
    pageTitle ??
    (udemy ? 'Udemy certificate of completion' : 'SAP digital badge')
  )
    .replace(/\s*[|–-]\s*(Udemy|Credly).*$/i, '')
    .trim()
  const issuerName = udemy ? 'Udemy' : 'SAP (via Credly)'
  const subjectName = htmlMetadata(html, 'profile:first_name')
    ? [
        htmlMetadata(html, 'profile:first_name'),
        htmlMetadata(html, 'profile:last_name')
      ]
        .filter(Boolean)
        .join(' ')
    : undefined

  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: url,
    type: ['VerifiableCredential', 'LearningAchievementCredential'],
    issuer: {
      id: `https://${udemy ? 'www.udemy.com' : 'www.credly.com'}`,
      name: issuerName
    },
    credentialSubject: {
      ...(subjectName ? { name: subjectName } : {}),
      achievement: { name: title, ...(description ? { description } : {}) }
    },
    evidence: [
      {
        type: ['Evidence'],
        id: url,
        name: 'Original certificate or badge page'
      }
    ]
  } as unknown as IVerifiableCredential
}

/**
 * A method for decoding credentials from a variety text formats.
 * Used on the Add Credential screen (when a user scans QR code or pastes
 * something into the text box).
 *
 * @param text - A string containing a VPQR, URL, or JSON object.
 * @returns {Promise<IVerifiableCredential[]>} - An array of credentials.
 */
export async function credentialsFrom(
  text: string
): Promise<IVerifiableCredential[]> {
  text = text.trim()

  // SAP certificate PDFs can include reference strings that resemble Udemy's
  // UC-<UUID> IDs. Identify the certificate from its SAP title and Credly
  // badge URL before the generic Udemy ID fallback below.
  const sapPdfCredential = sapCertificateCredentialFromPdfText(text)
  if (sapPdfCredential) return [await enrichSapPdfCredential(sapPdfCredential)]

  const pastedUdemyId = udemyCertificateIdFromText(text)
  if (pastedUdemyId) {
    const parsedCertificate = udemyCertificateCredentialFromText(
      text,
      pastedUdemyId
    )
    if (parsedCertificate) return [parsedCertificate]
    text = `https://www.udemy.com/certificate/${pastedUdemyId}/`
  }

  const certForgeId = certForgeCredentialIdFrom(text)
  if (certForgeId) return [await fetchCertForgeCredential(certForgeId)]
  if (isCertForgeHomepage(text)) {
    throw new Error(
      'This CertForge QR opens the homepage and does not identify a certificate. Enter the printed CertForge ID to look up its verified Open Badges credential.'
    )
  }

  if (regexPattern.url.test(text)) {
    let fetchUrl = text
    let udemyCertificateId: string | undefined

    try {
      const source = new URL(text)
      const host = source.hostname.toLowerCase()
      const isUdemyCertificate =
        host === 'ude.my' ||
        host === 'udemy.com' ||
        host.endsWith('.udemy.com') ||
        host === 'udemy-certificate.s3.amazonaws.com'
      if (isUdemyCertificate) {
        udemyCertificateId = udemyCertificateIdFromText(text)
        if (udemyCertificateId) {
          // Udemy's short link opens a web page that is difficult for the
          // in-app client to parse. The public S3 PDF contains the record.
          fetchUrl = `https://udemy-certificate.s3.amazonaws.com/pdf/${udemyCertificateId}.pdf`
        }
      }
    } catch {
      // Continue with the supplied URL if it cannot be normalized.
    }

    // If the scanned URL is a verifier web link with ?vc= or #verify?vc=
    try {
      const parsedUrl = new URL(text)
      const hash = parsedUrl.hash ? parsedUrl.hash.slice(1) : ''
      const hashParams = new URLSearchParams(
        hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : hash
      )
      const rawHashVc = /^verify\?vc=(.*)$/s.exec(hash)?.[1]
      const vcParam = rawHashVc
        ? decodeURIComponent(rawHashVc)
        : hashParams.get('vc') || parsedUrl.searchParams.get('vc')

      if (vcParam && /^https?:\/\//i.test(vcParam)) {
        fetchUrl = vcParam
      }
    } catch {
      // Continue with original url if URL parsing is not applicable
    }

    const response = await fetch(fetchUrl, {
      headers: {
        Accept:
          'application/pdf, text/html, application/xhtml+xml, application/json, application/ld+json, application/vc+jwt, image/png, text/plain'
      }
    })
    if (!response.ok) {
      throw new Error(`The credential URL returned HTTP ${response.status}.`)
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (isPngBytes(bytes)) {
      text = credentialTextFromPng(bytes)
    } else if (
      udemyCertificateId &&
      (response.headers.get('content-type')?.includes('pdf') ||
        (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44))
    ) {
      const pdfText = await udemyCertificateTextFromPdfBytes(
        bytes,
        udemyCertificateId
      )
      const certificate = udemyCertificateCredentialFromText(
        pdfText,
        udemyCertificateId
      )
      if (certificate) return [certificate]
      throw new Error(
        'Udemy returned the certificate PDF, but its details could not be read. Choose the PDF file on Android or check the certificate ID.'
      )
    } else {
      text = new TextDecoder().decode(bytes).trim()
      const contentType = response.headers.get('content-type') ?? ''
      if (credentialLooksLikeHtml(text, contentType)) {
        const sourceHtml = text
        const representations = credentialRepresentationsFromHtml(sourceHtml)
        let lastError: unknown
        for (const representation of representations) {
          try {
            if (representation.startsWith('__credential_url__:')) {
              const representationUrl = new URL(
                representation.slice('__credential_url__:'.length),
                response.url || fetchUrl
              ).toString()
              const credentialResponse = await fetch(representationUrl, {
                headers: {
                  Accept:
                    'application/json, application/ld+json, application/vc+json, application/vc+jwt, text/plain'
                }
              })
              if (!credentialResponse.ok) {
                throw new Error(
                  `The badge representation returned HTTP ${credentialResponse.status}.`
                )
              }
              const credentialBytes = new Uint8Array(
                await credentialResponse.arrayBuffer()
              )
              text = isPngBytes(credentialBytes)
                ? credentialTextFromPng(credentialBytes)
                : new TextDecoder().decode(credentialBytes).trim()
            } else {
              text = representation
            }
            if (isCompactJwt(text)) return [await credentialFromJwtVc(text)]
            if (regexPattern.json.test(text)) return credentialsFromJson(text)
          } catch (error) {
            lastError = error
          }
        }
        const learningCertificate = unverifiedLearningCertificateFromHtml(
          sourceHtml,
          response.url || fetchUrl
        )
        if (learningCertificate) return [learningCertificate]
        throw new Error(
          lastError instanceof Error
            ? `This badge page did not provide a usable Open Badges credential: ${lastError.message}`
            : 'This QR opens an issuer webpage but does not provide the signed Open Badges credential. Scan a credential link/QR or import the issuer-provided badge file.'
        )
      }
    }
  }

  if (regexPattern.vpqr.test(text)) {
    return credentialsFromVpqr(text)
  }

  if (isCompactJwt(text)) {
    return [await credentialFromJwtVc(text)]
  }

  if (regexPattern.json.test(text)) {
    return credentialsFromJson(text)
  }

  throw new Error(
    pastedUdemyId
      ? 'Udemy returned no readable certificate record for this ID. Check the ID and internet connection.'
      : 'No credentials were resolved from the text'
  )
}

/**
 * Returns a unique identifier for a credential record.
 * Uses the database record ID to ensure uniqueness across all credentials,
 * even if they have the same or missing credential.id field.
 *
 * This addresses the issue where multiple credentials with the same or missing
 * credential.id would collide when used as cache keys for public links.
 */
export function credentialIdFor(
  rawCredentialRecord: CredentialRecordRaw
): string {
  return (
    rawCredentialRecord._id.toHexString?.() || String(rawCredentialRecord._id)
  )
}
