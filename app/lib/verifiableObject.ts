import { LruCache } from '@digitalcredentials/lru-memoize'
import {
  isVerifiableCredential,
  isVerifiablePresentation,
  ResultLog,
  verifyCredential
} from './validate'
import { CredentialRecordRaw } from '../model'
import {
  IVerifiableCredential,
  IVerifiablePresentation
} from '@digitalcredentials/ssi'

/**
 * This type is used to identify a request response that could be a
 * Verifiable Credential or Verifiable Presentation.
 */
export type VerifiableObject = IVerifiableCredential | IVerifiablePresentation

export function extractCredentialsFrom(
  obj: IVerifiableCredential | IVerifiablePresentation
): IVerifiableCredential[] | null {
  if (isVerifiableCredential(obj)) {
    return [obj]
  }
  if (isVerifiablePresentation(obj) && 'verifiableCredential' in obj) {
    const verifiableCredential = obj.verifiableCredential!

    if (Array.isArray(verifiableCredential)) {
      return verifiableCredential
    }
    return [verifiableCredential]
  }

  return null
}

/* Cache verification results briefly to avoid duplicate UI verification work. */
const VERIFICATION_CACHE_TTL_MINUTES = 15
const lruCache = new LruCache({
  maxAge: VERIFICATION_CACHE_TTL_MINUTES * 60 * 1000
})
export type VerificationResult = {
  timestamp: number | null
  log: ResultLog[]
  verified: boolean | null
  error?: Error
}

export type VerifyPayload = {
  loading: boolean
  error: string | null
  result: VerificationResult
}

export async function verificationResultFor({
  rawCredentialRecord,
  forceFresh = false
}: {
  rawCredentialRecord: CredentialRecordRaw
  forceFresh?: boolean
}): Promise<VerificationResult> {
  const cachedRecordId = String(rawCredentialRecord._id)
  const verify = async (): Promise<VerificationResult> => {
    try {
      const response = await verifyCredential(rawCredentialRecord.credential)
      const rootLog = response.log ?? []
      return {
        verified: response.verified,
        // The verification library may return checks at the top level or
        // inside each credential result. Always return the same shape to UI.
        log:
          rootLog.length > 0
            ? rootLog
            : (response.results?.flatMap((item) => item.log ?? []) ?? []),
        timestamp: Date.now()
      }
    } catch (err) {
      return {
        verified: false,
        log: [],
        timestamp: Date.now(),
        error: err as Error
      }
    }
  }

  if (forceFresh) return verify()

  return (await lruCache.memoize({
    key: cachedRecordId,
    fn: verify
  })) as VerificationResult
}
