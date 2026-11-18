import type { IVerifiableCredential } from '@digitalcredentials/ssi'

import credentialFixtures from '../data/offlineDemoCredentials.json'

export type OfflineDemoCredential = {
  id: string
  name: string
  did: string
  credential: IVerifiableCredential
}

export const OFFLINE_DEMO_CREDENTIALS =
  credentialFixtures as OfflineDemoCredential[]

export function offlineDemoIssuerFor(
  credential: IVerifiableCredential
): OfflineDemoCredential | undefined {
  const issuerId =
    typeof credential.issuer === 'string'
      ? credential.issuer
      : credential.issuer?.id
  return OFFLINE_DEMO_CREDENTIALS.find((issuer) => issuer.did === issuerId)
}
