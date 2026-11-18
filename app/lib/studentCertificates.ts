import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import { IVerifiableCredential } from '@digitalcredentials/ssi'

import store from '../store'
import {
  addCredential,
  selectRawCredentialRecords
} from '../store/slices/credential'
import { selectRawProfileRecords } from '../store/slices/profile'
import { verifyCredential } from './validate'

const CERTIFICATE_API = 'https://certificate-3g1x.onrender.com/api/certificates'

export const STUDENT_PROFILE_KEY = 'ndear_student_profile'

export type StudentProfile = {
  fullName: string
  dateOfBirth: string
}

export type FetchedCertificate = IVerifiableCredential & {
  '@context': string[]
  id: string
  type: string[]
  issuer: { id: string; name: string }
  issuanceDate?: string
  validFrom?: string
  credentialSubject: {
    id: string
    name: string
    dateOfBirth: string
    hasCredential: {
      type: string[]
      name: string
      description: string
      duration: string
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Checks the untrusted service response shape without changing signed fields. */
export function isFetchedCertificate(
  value: unknown
): value is FetchedCertificate {
  if (!isRecord(value)) return false
  const issuer = value.issuer
  const subject = value.credentialSubject
  return (
    typeof value.id === 'string' &&
    Array.isArray(value['@context']) &&
    Array.isArray(value.type) &&
    value.type.includes('VerifiableCredential') &&
    (typeof issuer === 'string' ||
      (isRecord(issuer) && typeof issuer.id === 'string')) &&
    (typeof value.issuanceDate === 'string' ||
      typeof value.validFrom === 'string') &&
    isRecord(subject)
  )
}

function isImportableCredential(
  value: unknown
): value is IVerifiableCredential {
  return (
    isRecord(value) &&
    Array.isArray(value.type) &&
    value.type.includes('VerifiableCredential')
  )
}

/** Verify an imported item before it can be persisted in the wallet. */
export async function importCertificateIfVerified(
  value: unknown
): Promise<boolean> {
  if (!isImportableCredential(value)) {
    throw new Error('The imported item is not a verifiable credential.')
  }

  const profile = selectRawProfileRecords(store.getState())[0]
  if (!profile) {
    throw new Error(
      'No active wallet profile is available for certificate import.'
    )
  }

  const existing = selectRawCredentialRecords(store.getState()).some(
    (record) => record.credential.id === value.id
  )
  if (existing) return false

  const verification = await verifyCredential(value)
  if (!verification.verified) {
    const reasons = (verification.log ?? [])
      .filter((entry) => !entry.valid)
      .map((entry) => `${entry.id}: ${entry.error?.message ?? 'check failed'}`)
    throw new Error(
      reasons.length > 0
        ? `Certificate was not stored because verification failed (${reasons.join('; ')}).`
        : 'Certificate was not stored because the verifier could not validate its proof, issuer, or status.'
    )
  }

  await store
    .dispatch(
      addCredential({
        credential: value,
        profileRecordId: profile._id
      })
    )
    .unwrap()
  return true
}

/**
 * Saves the student's profile (full name + DOB) to AsyncStorage.
 */
export async function saveStudentProfile(
  profile: StudentProfile
): Promise<void> {
  await SecureStore.setItemAsync(STUDENT_PROFILE_KEY, JSON.stringify(profile))
}

/**
 * Retrieves the student's saved profile from AsyncStorage.
 */
export async function getStudentProfile(): Promise<StudentProfile | null> {
  let raw = await SecureStore.getItemAsync(STUDENT_PROFILE_KEY)
  if (!raw) {
    // Migrate profiles written by older app versions to OS-protected storage.
    const legacyRaw = await AsyncStorage.getItem(STUDENT_PROFILE_KEY)
    if (legacyRaw) {
      await SecureStore.setItemAsync(STUDENT_PROFILE_KEY, legacyRaw)
      await AsyncStorage.removeItem(STUDENT_PROFILE_KEY)
      raw = legacyRaw
    }
  }
  if (!raw) return null
  try {
    return JSON.parse(raw) as StudentProfile
  } catch {
    return null
  }
}

/**
 * Fetches all certificates for a student from the Certificate Studio backend
 * using their full name and date of birth.
 * Returns an empty array if none are found or if the request fails.
 */
export async function fetchCertificatesFromStudio(
  fullName: string,
  dateOfBirth: string
): Promise<FetchedCertificate[]> {
  try {
    const params = new URLSearchParams({
      fullName: fullName.trim(),
      dateOfBirth: dateOfBirth.trim()
    })
    const response = await fetch(
      `${CERTIFICATE_API}/student?${params.toString()}`,
      {
        headers: { Accept: 'application/json' }
      }
    )
    if (!response.ok) return []
    const data: unknown = await response.json()
    if (
      !isRecord(data) ||
      data.found !== true ||
      !Array.isArray(data.certificates)
    ) {
      return []
    }
    return data.certificates.filter(isFetchedCertificate)
  } catch (err) {
    console.warn('[studentCertificates] Fetch failed:', err)
    return []
  }
}

/**
 * Fetches newly-issued certificates and imports them into the active wallet
 * profile. Existing credentials are left unchanged.
 */
export async function syncAndImportStudentCertificates(
  fullName: string,
  dateOfBirth: string
): Promise<number> {
  const certificates = await fetchCertificatesFromStudio(fullName, dateOfBirth)
  if (certificates.length === 0) return 0

  const profile = selectRawProfileRecords(store.getState())[0]
  if (!profile) {
    throw new Error(
      'No active wallet profile is available for certificate import.'
    )
  }

  const existingIds = new Set(
    selectRawCredentialRecords(store.getState()).map(
      (record) => record.credential.id
    )
  )
  let imported = 0
  for (const certificate of certificates) {
    if (existingIds.has(certificate.id)) continue
    try {
      if (await importCertificateIfVerified(certificate)) {
        existingIds.add(certificate.id)
        imported += 1
      }
    } catch (error) {
      console.warn(
        '[studentCertificates] Skipping unverified certificate',
        certificate.id,
        error
      )
    }
  }

  return imported
}
