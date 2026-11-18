import AsyncStorage from '@react-native-async-storage/async-storage'
import { Alert } from 'react-native'
import {
  importCertificateIfVerified,
  isFetchedCertificate
} from './studentCertificates'
import { credentialsFrom } from './decode'

const API = 'https://certificate-3g1x.onrender.com/api/certificates'
const PENDING_HANDOFF_KEY = 'ndear_pending_certificate_handoff'

function isCertificateHandoff(url: string): boolean {
  return url.startsWith('ndear://certificate/import')
}

function queryValue(url: string, key: string): string {
  const query = url.split('?')[1] ?? ''
  return new URLSearchParams(query).get(key) ?? ''
}

async function importHandoff(url: string): Promise<void> {
  await AsyncStorage.setItem(PENDING_HANDOFF_KEY, url)
  const credentialUrl = queryValue(url, 'url')
  if (credentialUrl) {
    const parsedUrl = new URL(credentialUrl)
    if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
      throw new Error('Credential link must use HTTP or HTTPS.')
    }
    const credentials = await credentialsFrom(parsedUrl.toString())
    if (credentials.length === 0) {
      throw new Error('No verifiable credential was found at that link.')
    }
    await importCertificateIfVerified(credentials[0])
    await AsyncStorage.removeItem(PENDING_HANDOFF_KEY)
    return
  }

  const name = queryValue(url, 'name')
  const dob = queryValue(url, 'dob')
  const certificateId = queryValue(url, 'certificateId')
  if (!name || !dob) {
    await AsyncStorage.removeItem(PENDING_HANDOFF_KEY)
    return
  }

  const response = await fetch(
    `${API}/student?fullName=${encodeURIComponent(name)}&dateOfBirth=${encodeURIComponent(dob)}`
  )
  if (!response.ok)
    throw new Error(`Certificate lookup failed with status ${response.status}`)
  const data: unknown = await response.json()
  const responseCertificates =
    typeof data === 'object' && data !== null && 'certificates' in data
      ? data.certificates
      : undefined
  const certificates = Array.isArray(responseCertificates)
    ? responseCertificates.filter(isFetchedCertificate)
    : []
  const matching = certificateId
    ? certificates.filter((credential) => credential.id.endsWith(certificateId))
    : certificates
  for (const credential of matching)
    await importCertificateIfVerified(credential)
  await AsyncStorage.removeItem(PENDING_HANDOFF_KEY)
}

export async function handleCertificateHandoff(url: string): Promise<boolean> {
  if (!isCertificateHandoff(url)) return false
  try {
    await importHandoff(url)
  } catch (error) {
    console.warn('[certificateHandoff] Import failed:', error)
    Alert.alert(
      'Credential not imported',
      error instanceof Error
        ? error.message
        : 'The credential could not be verified and stored.'
    )
  }
  return true
}

export async function retryPendingCertificateHandoff(): Promise<void> {
  const pending = await AsyncStorage.getItem(PENDING_HANDOFF_KEY)
  if (pending) await handleCertificateHandoff(pending)
}
