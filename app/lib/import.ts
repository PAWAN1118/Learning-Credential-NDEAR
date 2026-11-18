import DocumentPicker from 'react-native-document-picker'
import * as RNFS from 'react-native-fs'
import { NativeModules, Platform } from 'react-native'
import base64 from 'react-native-base64'

import { ProfileRecord } from '../model'
import { CredentialImportReport } from '../types/credential'
import { parseWalletContents } from './parseWallet'
import {
  credentialTextFromPng,
  learningCertificateUrlPrintedInText,
  sapCertificateCredentialFromPdfText,
  textFromPdfBytes
} from './decode'

// Type augmentation for global object
declare global {
  // eslint-disable-next-line no-var
  var base64ToArrayBuffer: ((base64Str: string) => ArrayBuffer) | undefined
}

// Local polyfill for base64ToArrayBuffer to avoid global dependency issues
if (typeof global.base64ToArrayBuffer !== 'function') {
  global.base64ToArrayBuffer = (base64Str: string) => {
    const decoded = base64.decode(base64Str)
    const bytes = new Uint8Array(decoded.length)
    for (let i = 0; i < decoded.length; i++) {
      bytes[i] = decoded.charCodeAt(i)
    }
    return bytes.buffer
  }
}

export type ReportDetails = Record<string, string[]>

export function base64ToArrayBuffer(base64Str: string): ArrayBuffer {
  const decoded = base64.decode(base64Str)
  const bytes = new Uint8Array(decoded.length)
  for (let i = 0; i < decoded.length; i++) {
    bytes[i] = decoded.charCodeAt(i)
  }
  return bytes.buffer
}

// Identify PNG open badges by content
export function isPngFile(base64Str: string): boolean {
  try {
    // Read just enough base64 characters to get the PNG header (8 bytes)
    const base64Header = base64Str.substring(0, 24)
    const arrayBuffer = base64ToArrayBuffer(base64Header)
    const header = new Uint8Array(arrayBuffer).slice(0, 8)
    const pngMagic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    const isPng = pngMagic.every((b, i) => header[i] === b)

    return isPng
  } catch (e) {
    return false
  }
}

export async function readFile(uri: string): Promise<string> {
  try {
    let path = uri

    if (Platform.OS === 'ios' && path.startsWith('file://')) {
      path = path.replace('file://', '')
    }
    // Read as base64 first
    const base64Data = await RNFS.readFile(path, 'base64')

    const bytes = new Uint8Array(base64ToArrayBuffer(base64Data))
    const pdfText = textFromPdfBytes(bytes)
    const isPdf =
      bytes[0] === 0x25 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x44 &&
      bytes[3] === 0x46
    if (isPdf) {
      const sapCredential = sapCertificateCredentialFromPdfText(pdfText)
      if (sapCredential) return JSON.stringify(sapCredential, null, 2)
      if (learningCertificateUrlPrintedInText(pdfText)) return pdfText

      // Scanned PDFs can contain noise in their text layer. OCR the page when
      // no usable certificate URL or ID was found in that layer.
      if (
        Platform.OS === 'android' &&
        NativeModules.UdemyPdfOcr?.readFirstPage
      ) {
        const recognizedText: string =
          await NativeModules.UdemyPdfOcr.readFirstPage(path)
        if (recognizedText?.trim()) return recognizedText
      }
      return pdfText
    }

    if (pdfText) return pdfText

    if (isPngFile(base64Data)) {
      const arrayBuffer = base64ToArrayBuffer(base64Data)
      const objectString = credentialTextFromPng(new Uint8Array(arrayBuffer))
      return JSON.stringify(JSON.parse(objectString), null, 2)
    } else {
      const fileContent = await RNFS.readFile(path, 'utf8')
      return fileContent
    }
  } catch (error) {
    console.error('Error reading file:', error)
    return ''
  }
}

export async function pickAndReadFile(): Promise<string> {
  try {
    const file = await DocumentPicker.pickSingle({
      type: DocumentPicker.types.allFiles,
      copyTo: 'cachesDirectory'
    })

    let path: string | null = null

    if (Platform.OS === 'ios') {
      path = file.fileCopyUri
      if (!path) throw new Error('No fileCopyUri on iOS')
      path = decodeURI(path.replace('file://', ''))
    } else {
      path = file.uri

      if (path.startsWith('content://')) {
        // Sanitize filename by removing extra dots to avoid collision
        const safeFileName = (file.name ?? 'imported_file').replace(
          /[^a-zA-Z0-9]/g,
          '_'
        )
        const destPath = `${RNFS.TemporaryDirectoryPath}/${safeFileName}`

        await RNFS.copyFile(path, destPath)
        path = destPath
      } else {
        // Decode any encoded URI and remove file:// if present
        path = decodeURI(path.replace('file://', ''))
      }
    }

    const exists = await RNFS.exists(path)

    if (!exists) throw new Error(`File not found at ${path}`)

    const content = await readFile(path)
    return content
  } catch (err) {
    throw new Error('Unable to read selected file.')
  }
}

export function credentialReportDetailsFrom(
  report: CredentialImportReport
): ReportDetails {
  const sectionText: Record<string, (n: number, s: string) => string> = {
    success: (n, s) => `${n} item${s} successfully imported`,
    duplicate: (n, s) => `${n} duplicate item${s} ignored`,
    failed: (n, s) => `${n} item${s} failed to complete`
  }

  return Object.fromEntries<string[]>(
    Object.entries(report)
      .filter(([, value]) => value.length > 0)
      .map(([key, value]) => {
        const plural = value.length !== 1 ? 's' : ''
        const headerText = sectionText[key](value.length, plural)
        return [headerText, value]
      })
  )
}

export function aggregateCredentialReports(
  reports: CredentialImportReport[]
): CredentialImportReport {
  return reports.reduce((prevValue, curValue) => ({
    success: prevValue.success.concat(curValue.success),
    duplicate: prevValue.duplicate.concat(curValue.duplicate),
    failed: prevValue.failed.concat(curValue.failed)
  }))
}

export async function importProfileFrom(data: string): Promise<ReportDetails> {
  const profileImportReport = await ProfileRecord.importProfileRecord(data)

  let userIdStatusText: string
  if (profileImportReport.profileDuplicate) {
    userIdStatusText = 'Profile already exists (skipped)'
  } else if (profileImportReport.userIdImported) {
    userIdStatusText = 'User ID successfully imported'
  } else {
    userIdStatusText = 'User ID failed to import'
  }

  const reportDetails = {
    [userIdStatusText]: [],
    ...credentialReportDetailsFrom(profileImportReport.credentials)
  }

  return reportDetails
}

export async function importWalletFrom(data: string): Promise<ReportDetails> {
  const items: unknown[] = JSON.parse(data)

  const reports = await Promise.all(
    items.map(async (item, index) => {
      const rawWallet = JSON.stringify(item)
      const report = await ProfileRecord.importProfileRecord(rawWallet)

      // Extract profile name from the wallet data
      try {
        const { profileMetadata } = parseWalletContents(rawWallet)
        const profileName =
          profileMetadata?.data?.profileName || 'Untitled Profile'
        return { ...report, profileName }
      } catch {
        return { ...report, profileName: `Profile ${index + 1}` }
      }
    })
  )

  const credentialReports = reports.map(({ credentials }) => credentials)
  const totalCredentialsReport = aggregateCredentialReports(credentialReports)

  // Collect profile names by import status
  const profilesImported = reports
    .filter((r) => r.userIdImported)
    .map((r) => r.profileName)
  const profilesDuplicate = reports
    .filter((r) => r.profileDuplicate)
    .map((r) => r.profileName)
  const profilesFailed = reports
    .filter((r) => !r.userIdImported && !r.profileDuplicate)
    .map((r) => r.profileName)

  const reportDetails: ReportDetails = {
    ...credentialReportDetailsFrom(totalCredentialsReport)
  }

  if (profilesImported.length > 0) {
    const plural = profilesImported.length !== 1 ? 's' : ''
    reportDetails[
      `${profilesImported.length} profile${plural} successfully imported`
    ] = profilesImported
  }

  if (profilesDuplicate.length > 0) {
    const plural = profilesDuplicate.length !== 1 ? 's' : ''
    reportDetails[
      `${profilesDuplicate.length} duplicate profile${plural} skipped`
    ] = profilesDuplicate
  }

  if (profilesFailed.length > 0) {
    const plural = profilesFailed.length !== 1 ? 's' : ''
    reportDetails[
      `${profilesFailed.length} profile${plural} failed to import`
    ] = profilesFailed
  }

  return reportDetails
}

export async function importWalletOrProfileFrom(
  data: string
): Promise<ReportDetails> {
  const parsedData = JSON.parse(data)

  if (parsedData instanceof Array) {
    return importWalletFrom(data)
  }

  return importProfileFrom(data)
}
