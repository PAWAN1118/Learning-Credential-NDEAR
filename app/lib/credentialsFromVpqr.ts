import {
  IVerifiableCredential,
  IVerifiablePresentation
} from '@digitalcredentials/ssi'
import { fromQrCode } from '@digitalcredentials/vpqr'
import { securityLoader } from '@digitalcredentials/security-document-loader'

import { credentialsFromPresentation } from './credentialsFromPresentation'

// Use bundled, trusted contexts so a scanned presentation can be decoded
// without reaching out to the network. Unknown contexts fail closed.
const documentLoader = securityLoader().build()

export async function credentialsFromVpqr(
  text: string
): Promise<IVerifiableCredential[]> {
  const { vp }: { vp: IVerifiablePresentation } = await fromQrCode({
    text,
    documentLoader
  })
  return credentialsFromPresentation(vp)
}
