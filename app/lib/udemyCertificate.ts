import { NativeModules, Platform } from 'react-native'
import * as RNFS from 'react-native-fs'
import base64 from 'react-native-base64'
import { IVerifiableCredential } from '@digitalcredentials/ssi'

export function udemyCertificateIdFromText(text: string): string | undefined {
  const match =
    // The UC- prefix is mandatory. Credly/SAP badge URLs also contain UUIDs.
    /\bU\s*C\s*[-–—:]?\s*([a-f0-9oil]{8}[-–—][a-f0-9oil]{4}[-–—][a-f0-9oil]{4}[-–—][a-f0-9oil]{4}[-–—][a-f0-9oil]{12})\b/i.exec(
      text
    )
  if (!match) return undefined
  const uuid = match[1]
    .replace(/[–—]/g, '-')
    .replace(/[o]/gi, '0')
    .replace(/[il]/gi, '1')
  return `UC-${uuid}`
}

function isoDate(value?: string): string | undefined {
  if (!value) return undefined
  const parsed = Date.parse(value.replace(/\b([A-Za-z]{3})\./g, '$1'))
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString()
}

function labeledValue(text: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^\\s*${escaped}\\s*:?\\s*(.+?)\\s*$`, 'im')
    .exec(text)?.[1]
    ?.trim()
}

export function udemyCertificateCredentialFromText(
  text: string,
  knownId?: string
): IVerifiableCredential | undefined {
  const certificateId = knownId ?? udemyCertificateIdFromText(text)
  if (!certificateId) return undefined

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*#+\s*/, '').trim())
    .filter(Boolean)
  const heading = /CERTIFICATE\s+OF\s+COMPLETI[O0]N/i.exec(text)
  const courseSection = heading
    ? text
        .slice(heading.index + heading[0].length)
        .split(/\b(?:Instructors?|Recipient|Awarded to|Date|Length)\b/i)[0]
    : ''
  const titleFromHeading = courseSection
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*#+\s*/, '').trim())
    .filter((line) => line && !/^(Udemy|Certificate\s)/i.test(line))
    .join(' ')
    .trim()
  const instructorIndex = lines.findIndex((line) =>
    /^Instructors?\b/i.test(line)
  )
  const endIndex = lines.findIndex((line) => /^Date\b/i.test(line))
  const fallbackTitleLines = lines
    .slice(0, instructorIndex >= 0 ? instructorIndex : endIndex)
    .filter(
      (line) =>
        !/^(Udemy|Certificate\s+(?:no|url|of)|Reference\s+Number|0004)\b/i.test(
          line
        )
    )
  const title =
    titleFromHeading || fallbackTitleLines.slice(-2).join(' ').trim()
  if (!title) return undefined

  const recipient =
    labeledValue(text, 'Recipient') ??
    labeledValue(text, 'Certificate awarded to') ??
    labeledValue(text, 'Awarded to') ??
    (() => {
      const dateIndex = endIndex
      return instructorIndex >= 0 && dateIndex > instructorIndex + 1
        ? lines[dateIndex - 1]
        : undefined
    })()
  const instructorLine = lines[instructorIndex]
  const instructorValue = instructorLine?.replace(
    /^Instructors?\s*:?[\s]*/i,
    ''
  )
  const instructor =
    instructorValue ||
    (instructorIndex >= 0 && lines[instructorIndex + 1]
      ? lines[instructorIndex + 1]
      : undefined)
  const dateText = labeledValue(text, 'Date')
  const length = labeledValue(text, 'Length')
  const details = [
    instructor ? `Instructor: ${instructor}` : undefined,
    length ? `Course length: ${length}` : undefined
  ].filter(Boolean)
  const certificateUrl = `https://www.udemy.com/certificate/${certificateId}/`

  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: certificateUrl,
    type: ['VerifiableCredential', 'LearningAchievementCredential'],
    issuer: { id: 'https://www.udemy.com', name: 'Udemy' },
    ...(isoDate(dateText) ? { issuanceDate: isoDate(dateText) } : {}),
    credentialSubject: {
      ...(recipient ? { name: recipient } : {}),
      achievement: {
        name: title,
        ...(details.length ? { description: details.join('. ') } : {})
      }
    },
    evidence: [
      { type: ['Evidence'], id: certificateUrl, name: 'Udemy certificate' }
    ]
  } as unknown as IVerifiableCredential
}

/** OCR a remotely resolved Udemy certificate PDF with the bundled Android model. */
export async function udemyCertificateTextFromPdfBytes(
  bytes: Uint8Array,
  certificateId: string
): Promise<string> {
  if (Platform.OS !== 'android' || !NativeModules.UdemyPdfOcr?.readFirstPage) {
    return ''
  }
  const safeId = certificateId.replace(/[^a-z0-9-]/gi, '')
  const path = `${RNFS.CachesDirectoryPath}/udemy-${safeId}.pdf`
  try {
    const binaryChunks: string[] = []
    const chunkSize = 0x8000
    for (let index = 0; index < bytes.length; index += chunkSize) {
      binaryChunks.push(
        String.fromCharCode(...bytes.subarray(index, index + chunkSize))
      )
    }
    await RNFS.writeFile(path, base64.encode(binaryChunks.join('')), 'base64')
    return await NativeModules.UdemyPdfOcr.readFirstPage(path)
  } catch {
    return ''
  } finally {
    await RNFS.unlink(path).catch(() => undefined)
  }
}
