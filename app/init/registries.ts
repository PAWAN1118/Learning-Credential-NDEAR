import { createContext } from 'react'
import { RegistryClient } from '@digitalcredentials/issuer-registry-client'
import {
  getDemoRegistryUrl,
  registriesIncludingDemo
} from '../lib/demoRegistry'

const registries = new RegistryClient()

export const DidRegistryContext = createContext(registries)

/**
 * Loads remote Known Issuer / Known Verifier DID registries from config.
 */
export async function loadKnownDidRegistries({
  client
}: {
  client: RegistryClient
}) {
  const demoUrl = await getDemoRegistryUrl()
  await client.load({ config: registriesIncludingDemo(demoUrl) })
}
