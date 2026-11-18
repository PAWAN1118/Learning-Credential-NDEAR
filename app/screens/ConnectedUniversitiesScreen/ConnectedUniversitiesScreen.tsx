import React, { useState } from 'react'
import { Alert, ScrollView, Text, View } from 'react-native'
import { Button } from 'react-native-elements'
import QRCode from 'react-native-qrcode-svg'
import { MaterialIcons } from '@expo/vector-icons'
import { NavHeader } from '../../components'
import { useAppDispatch, useDynamicStyles } from '../../hooks'
import { navigationRef } from '../../navigation/navigationRef'
import { NavigationUtil } from '../../lib/navigationUtil'
import { OFFLINE_DEMO_CREDENTIALS } from '../../lib/offlineDemoCredentials'
import { stageCredentialsForProfile } from '../../store/slices/credentialFoyer'
import dynamicStyleSheet from './ConnectedUniversitiesScreen.styles'
import { ConnectedUniversitiesScreenProps } from './ConnectedUniversitiesScreen.d'

export default function ConnectedUniversitiesScreen({
  navigation
}: ConnectedUniversitiesScreenProps): React.ReactElement {
  const { styles, mixins } = useDynamicStyles(dynamicStyleSheet)
  const dispatch = useAppDispatch()
  const [visibleQrId, setVisibleQrId] = useState<string | null>(null)
  const [addingId, setAddingId] = useState<string | null>(null)

  async function addSampleCredential(issuerId: string) {
    const demo = OFFLINE_DEMO_CREDENTIALS.find(({ id }) => id === issuerId)
    if (!demo || addingId) return

    setAddingId(issuerId)
    try {
      const rawProfileRecord = await NavigationUtil.selectProfile()
      await dispatch(
        stageCredentialsForProfile({
          credentials: [demo.credential],
          profileRecordId: rawProfileRecord._id
        })
      ).unwrap()
      navigationRef.navigate('AcceptCredentialsNavigation', {
        screen: 'ApproveCredentialsScreen',
        params: { rawProfileRecord }
      })
    } catch (error) {
      Alert.alert(
        'Could not open demo credential',
        error instanceof Error ? error.message : 'Please try again.'
      )
    } finally {
      setAddingId(null)
    }
  }

  return (
    <>
      <NavHeader
        title="Offline Demo Organizations"
        goBack={() => navigation.goBack()}
      />
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
      >
        <Text style={styles.intro}>
          Three fictional education issuers are built into this APK. Their
          sample credentials are signed, checked against keys pinned in the
          wallet, and can be viewed offline. No server, registry URL, or Wi-Fi
          is needed for these demo samples. They are not real qualifications.
        </Text>
        {OFFLINE_DEMO_CREDENTIALS.map((demo) => {
          const showQr = visibleQrId === demo.id
          return (
            <View key={demo.id} style={styles.universityCard}>
              <View style={styles.cardHeader}>
                <View style={styles.iconCircle}>
                  <MaterialIcons name="school" size={22} color="#FFFFFF" />
                </View>
                <View style={styles.nameBlock}>
                  <Text style={styles.label}>OFFLINE · DEMO ONLY</Text>
                  <Text style={styles.name}>{demo.name}</Text>
                </View>
                <MaterialIcons name="verified" size={22} color="#8EE6C4" />
              </View>
              <Text style={styles.websiteLabel}>Sample achievement</Text>
              <Text style={styles.link}>{demo.credential.name}</Text>
              <Text style={styles.hint}>
                Signed credential for Demo Learner · EdDSA signature · works
                without a network connection
              </Text>
              <Button
                title={showQr ? 'Hide sample QR' : 'Show signed credential QR'}
                onPress={() => setVisibleQrId(showQr ? null : demo.id)}
                buttonStyle={mixins.buttonPrimary}
                titleStyle={mixins.buttonTitle}
                containerStyle={mixins.noFlex}
              />
              {showQr && (
                <View style={styles.qrPanel}>
                  <Text style={styles.qrHint}>
                    Scan this with Add → Scan QR on another device. The QR
                    contains the signed credential itself.
                  </Text>
                  <View style={styles.qrCode}>
                    <QRCode
                      value={JSON.stringify(demo.credential)}
                      size={220}
                      ecl="Q"
                    />
                  </View>
                </View>
              )}
              <Button
                title={
                  addingId === demo.id
                    ? 'Opening…'
                    : 'Add sample to this wallet'
                }
                onPress={() => void addSampleCredential(demo.id)}
                disabled={addingId !== null}
                buttonStyle={[mixins.buttonPrimary, styles.addButton]}
                titleStyle={mixins.buttonTitle}
                containerStyle={mixins.noFlex}
              />
            </View>
          )
        })}
        <Text style={styles.footer}>
          These samples prove the offline scan, signature verification, secure
          import, and wallet viewing flow. Live institutions and fresh
          revocation checks can require internet access.
        </Text>
      </ScrollView>
    </>
  )
}
