import AsyncStorage from '@react-native-async-storage/async-storage'
import { KnownDidRegistries } from '../../app.config'
import { OFFLINE_DEMO_CREDENTIALS } from './offlineDemoCredentials'

export const DEMO_REGISTRY_URL_KEY = 'ndear_demo_registry_url'

export const DEMO_ISSUERS = OFFLINE_DEMO_CREDENTIALS.map(
  ({ id, name, did }) => ({ id, name, did })
)

type RegistryEntry = {
  name: string
  url: string
  type?: string
}

export function isAllowedRegistryUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

function bakedDemoRegistryUrl(): string {
  const baked = KnownDidRegistries.find((entry) =>
    entry.name.includes('DEMO ONLY')
  )
  return baked?.url ?? ''
}

export async function getDemoRegistryUrl(): Promise<string> {
  const stored = await AsyncStorage.getItem(DEMO_REGISTRY_URL_KEY)
  if (stored && isAllowedRegistryUrl(stored)) {
    return stored.replace(/\/$/, '')
  }
  return bakedDemoRegistryUrl().replace(/\/$/, '')
}

export async function saveDemoRegistryUrl(value: string): Promise<string> {
  const trimmed = value.trim()
  if (!trimmed) {
    await AsyncStorage.removeItem(DEMO_REGISTRY_URL_KEY)
    return bakedDemoRegistryUrl().replace(/\/$/, '')
  }
  if (!isAllowedRegistryUrl(trimmed)) {
    throw new Error('Registry URL must start with http:// or https://')
  }
  const normalized = trimmed.replace(/\/$/, '')
  await AsyncStorage.setItem(DEMO_REGISTRY_URL_KEY, normalized)
  return normalized
}

export function registriesIncludingDemo(demoUrl: string): RegistryEntry[] {
  const demo: RegistryEntry[] = demoUrl
    ? [
        {
          name: 'NDEAR Demo Issuers (DEMO ONLY)',
          type: 'dcc-legacy',
          url: demoUrl
        }
      ]
    : []
  return [
    ...demo,
    ...KnownDidRegistries.filter((entry) => entry.url !== demoUrl)
  ]
}
