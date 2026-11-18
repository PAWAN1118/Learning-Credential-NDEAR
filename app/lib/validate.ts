import { CredentialError, PresentationError } from '../types/credential'
import * as verifierCore from '@digitalcredentials/verifier-core'
import {
  IVerifiableCredential,
  IVerifiablePresentation
} from '@digitalcredentials/ssi'
import { VerifiableObject } from './verifiableObject'
import { getDemoRegistryUrl, registriesIncludingDemo } from './demoRegistry'
import { offlineDemoIssuerFor } from './offlineDemoCredentials'
import { verifyCertForgeCredential } from './certForge'
import { verifyCredlyCredential } from './credly'
import { verifyUdemyCredential } from './udemy'

export type ResultLog = {
  id: string
  valid: boolean | undefined
  error?: any
}

export type Result = {
  verified: boolean
  credential: IVerifiableCredential
  error?:
    | CredentialError
    | { name?: string; message?: string; log?: ResultLog[] }
  log: ResultLog[]
}

export type VerifyResponse = {
  verified: boolean
  results: Result[]
  log?: ResultLog[]
  errors?: Array<{ name?: string; message?: string }>
}

export async function verifyPresentation(
  presentation: IVerifiablePresentation
): Promise<VerifyResponse> {
  try {
    const result = await verifierCore.verifyPresentation({
      presentation
    })
    if (!result.verified) {
      console.warn('VP not verified:', JSON.stringify(result, null, 2))
    }
    return result
  } catch (err) {
    console.warn(err)

    throw new Error(PresentationError.CouldNotBeVerified)
  }
}

export async function verifyCredential(
  credential: IVerifiableCredential
): Promise<VerifyResponse> {
  try {
    const udemyVerification = await verifyUdemyCredential(credential)
    if (udemyVerification) {
      const udemyProof = {
        name: 'udemy_public_certificate',
        message: udemyVerification.reason
      }
      const log: ResultLog[] = [
        {
          // Udemy certificates are public completion records, not signed VCs.
          id: 'valid_signature',
          valid: undefined,
          error: udemyProof
        },
        {
          id: 'registered_issuer',
          valid: udemyVerification.available
            ? udemyVerification.verified
            : undefined,
          error: udemyProof,
          ...(udemyVerification.verified
            ? {
                matchingIssuers: [
                  {
                    name: 'Udemy',
                    url: 'https://www.udemy.com',
                    source: 'Udemy public certificate page'
                  }
                ]
              }
            : {})
        },
        { id: 'revocation_status', valid: undefined, error: udemyProof },
        {
          id: 'expiration',
          valid: credential.expirationDate
            ? Date.parse(credential.expirationDate as string) > Date.now()
            : undefined,
          error: udemyProof
        }
      ]
      const verified =
        udemyVerification.verified &&
        (!credential.expirationDate ||
          Date.parse(credential.expirationDate as string) > Date.now())
      return {
        verified,
        log,
        results: [{ verified, credential, log }]
      }
    }

    const credlyVerification = await verifyCredlyCredential(credential)
    if (credlyVerification) {
      const credlyProof = {
        name: 'credly_hosted_assertion',
        message: credlyVerification.reason
      }
      const log: ResultLog[] = [
        {
          id: 'valid_signature',
          valid: credlyVerification.recordAvailable
            ? credlyVerification.verified
            : undefined,
          error: credlyProof
        },
        {
          id: 'registered_issuer',
          valid: credlyVerification.recordAvailable
            ? credlyVerification.issuerConfirmed
            : undefined,
          error: credlyProof,
          ...(credlyVerification.issuerConfirmed
            ? {
                matchingIssuers: [
                  {
                    name: credlyVerification.issuerName,
                    url: credlyVerification.issuerUrl,
                    source: 'Credly hosted badge assertion'
                  }
                ]
              }
            : {})
        },
        {
          id: 'revocation_status',
          // A failed lookup or issuer/title mismatch does not mean revoked.
          valid:
            credlyVerification.revoked === true
              ? false
              : credlyVerification.revoked === false
                ? true
                : undefined,
          error: credlyProof
        },
        {
          id: 'expiration',
          valid:
            (credlyVerification.expires ??
            (typeof credential.expirationDate === 'string'
              ? credential.expirationDate
              : undefined))
              ? Date.parse(
                  credlyVerification.expires ??
                    (credential.expirationDate as string)
                ) > Date.now()
              : undefined,
          error: credlyProof
        }
      ]
      return {
        verified: credlyVerification.verified,
        log,
        results: [{ verified: credlyVerification.verified, credential, log }]
      }
    }

    const certForgeVerification = await verifyCertForgeCredential(credential)
    if (certForgeVerification) {
      const log: ResultLog[] = [
        {
          id: 'valid_signature',
          valid: certForgeVerification.verified
        }
      ]
      if (certForgeVerification.revoked !== undefined) {
        log.push({
          id: 'revocation_status',
          valid: !certForgeVerification.revoked
        })
      }
      const verified =
        certForgeVerification.verified && certForgeVerification.revoked !== true
      return {
        verified,
        log,
        results: [{ verified, credential, log }]
      }
    }

    const offlineDemoIssuer = offlineDemoIssuerFor(credential)
    let result: Awaited<ReturnType<typeof verifierCore.verifyCredential>>

    if (offlineDemoIssuer) {
      // These demo DIDs are pinned in the APK. Verify the credential proof
      // locally and use the embedded issuer allowlist instead of a web registry.
      result = await verifierCore.verifyCredential({
        credential,
        knownDIDRegistries: []
      })
      const verificationChecks = (result.log ?? []) as Array<{
        id: string
        valid: boolean
        [key: string]: unknown
      }>
      result.log = verificationChecks.map((check) =>
        check.id === 'registered_issuer'
          ? {
              ...check,
              valid: true,
              matchingIssuers: [
                { name: offlineDemoIssuer.name, did: offlineDemoIssuer.did }
              ],
              offline: true
            }
          : check
      )
    } else {
      let remoteRegistries: ReturnType<typeof registriesIncludingDemo> = []
      try {
        const response = await fetch(
          'https://digitalcredentials.github.io/dcc-known-registries/known-did-registries.json'
        )
        if (response.ok) {
          remoteRegistries = await response.json()
        } else {
          console.warn(
            'Issuer registry request failed',
            response.status,
            '- continuing with locally configured registries'
          )
        }
      } catch (registryError) {
        console.warn(
          'Issuer registry request failed - continuing with locally configured registries',
          registryError
        )
      }
      const demoUrl = await getDemoRegistryUrl()
      const knownDIDRegistries = [
        ...registriesIncludingDemo(demoUrl),
        ...remoteRegistries.filter((entry) => entry.url !== demoUrl)
      ]
      result = await verifierCore.verifyCredential({
        credential,
        knownDIDRegistries
      })
    }

    // Some verifier-core versions return the checks on each result instead
    // of at the top level. Normalize that shape without dropping failed or
    // unavailable revocation checks (an unavailable status list is unknown,
    // not proof that the credential is valid).
    const rootLog = result.log as ResultLog[] | undefined
    const results = result.results as Result[] | undefined
    const logs =
      rootLog && rootLog.length > 0
        ? rootLog
        : (results?.flatMap((item) =>
            item.log?.length
              ? item.log
              : typeof item.error === 'object' && item.error?.log
                ? item.error.log
                : []
          ) ?? [])
    if (logs.length === 0 && Array.isArray(result.errors)) {
      for (const error of result.errors) {
        if (error.name === 'no_proof' || error.name === 'invalid_signature') {
          logs.push({
            id: 'valid_signature',
            valid: false,
            error
          })
        }
      }
    }
    result.log = logs
    result.verified =
      result.verified === false
        ? false
        : logs.length > 0 && logs.every((check: ResultLog) => check.valid)

    if (!result.results) {
      result.results = [
        {
          verified: result.verified,
          log: result.log,
          credential: result.credential
        }
      ]
    } else if (result.results[0] && !result.results[0].log?.length) {
      result.results[0].log = logs
    }

    if (!result.verified) {
      console.warn('VC not verified:', JSON.stringify(result, null, 2))
    }

    return result
  } catch (err) {
    console.warn(
      'verifyCredential',
      err,
      JSON.stringify(err, removeStackReplacer, 2)
    )

    throw new Error(CredentialError.CouldNotBeVerified)
  }
}

function removeStackReplacer(key: string, value: unknown) {
  return key === 'stack' ? '...' : value
}

export function isVerifiableCredential(
  obj: VerifiableObject
): obj is IVerifiableCredential {
  return obj.type?.includes('VerifiableCredential')
}

export function isVerifiablePresentation(
  obj: VerifiableObject
): obj is IVerifiablePresentation {
  return obj.type?.includes('VerifiablePresentation')
}

export async function verifyVerifiableObject(
  obj: VerifiableObject
): Promise<boolean> {
  try {
    if (isVerifiableCredential(obj)) {
      return (await verifyCredential(obj)).verified
    }
    if (isVerifiablePresentation(obj)) {
      return (await verifyPresentation(obj)).verified
    }
  } catch (err) {
    console.warn('Error while verifying:', err)
  }

  return false
}
