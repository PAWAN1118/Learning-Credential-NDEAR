import React, { useState } from 'react'
import { AccessibilityInfo, Text, View } from 'react-native'
import { Button } from 'react-native-elements'
import { MaterialCommunityIcons, MaterialIcons } from '@expo/vector-icons'
import { TextInput } from 'react-native-paper'
import { IVerifiableCredential } from '@digitalcredentials/ssi'

import ScreenIntro from '../../components/ScreenIntro/ScreenIntro'
import Motion from '../../components/Motion/Motion'

import dynamicStyleSheet from './AddScreen.styles'
import { stageCredentialsForProfile } from '../../store/slices/credentialFoyer'
import { NavHeader } from '../../components'
import {
  legacyRequestParamsFromUrl,
  credentialsFrom,
  isLegacyCredentialRequest
} from '../../lib/decode'
import { PresentationError } from '../../types/credential'
import { errorMessageMatches, HumanReadableError } from '../../lib/error'
import { navigationRef } from '../../navigation/navigationRef'
import { CredentialRequestParams } from '../../lib/credentialRequest'
import { pickAndReadFile } from '../../lib/import'
import { displayGlobalModal } from '../../lib/globalModal'
import { useAppDispatch, useDynamicStyles } from '../../hooks'
import { ScrollView } from 'react-native-gesture-handler'
import {
  NavigationUtil,
  redirectRequestRoute,
  redirectInteractionUrl
} from '../../lib/navigationUtil'
import { CANCEL_PICKER_MESSAGES } from '../../../app.config'
import {
  isDeepLink,
  isWalletApiMessage,
  parseWalletApiMessage
} from '../../lib/walletRequestApi'
import { isInteractionUrl } from '../../lib/interactionUrl'
import { handleCertificateHandoff } from '../../lib/certificateHandoff'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import {
  certForgeIdPrintedInText,
  isCertForgeHomepage
} from '../../lib/certForge'
import { learningCertificateUrlPrintedInText } from '../../lib/decode'

export async function goToCredentialFoyer(
  credentialRequestParams?: CredentialRequestParams
) {
  const rawProfileRecord = await NavigationUtil.selectProfile()
  navigationRef.navigate('AcceptCredentialsNavigation', {
    screen: 'ApproveCredentialsScreen',
    params: {
      rawProfileRecord,
      credentialRequestParams
    }
  })
}

export default function AddScreen(): React.ReactElement {
  const { styles, theme, mixins } = useDynamicStyles(dynamicStyleSheet)
  const [inputValue, setInputValue] = useState('')
  const [certForgeId, setCertForgeId] = useState('')
  const [certForgePromptOpen, setCertForgePromptOpen] = useState(false)
  const dispatch = useAppDispatch()
  const inputIsValid = inputValue !== ''

  function onPressQRScreen() {
    if (navigationRef.isReady()) {
      navigationRef.navigate('QRScreen', {
        instructionText:
          'Scan a shared QR code from your issuer to request your credentials.',
        onReadQRCode
      })
    }
  }

  async function goToCredentialFoyerWith(credentials: IVerifiableCredential[]) {
    const rawProfileRecord = await NavigationUtil.selectProfile()
    await dispatch(
      stageCredentialsForProfile({
        credentials,
        profileRecordId: rawProfileRecord._id
      })
    )
    navigationRef.navigate('AcceptCredentialsNavigation', {
      screen: 'ApproveCredentialsScreen',
      params: {
        rawProfileRecord
      }
    })
  }

  /**
   * Dispatches flow based on text pasted into the Add Credential
   * textbox.
   *
   * @param text {string} - One of:
   *   - A legacy Credential Request Flow link (with a 'vc_request_url' param)
   *       https://github.com/digitalcredentials/docs/blob/main/request/credential_request.md
   *   - An LCW universal app link (https://lcw.app/request?request=... )
   *   - An LCW custom protocol link (dccrequest://..?request=)
   *   - Raw JSON Wallet API Request
   *   - Raw JSON VP or VC, or a compact JWT VC
   *   - A URL to a remotely hosted VC, VP, or JWT VC
   *   - A Universal Interact invitation link (has a query param `iuv=1`)
   */
  async function addCredentialsFrom(text: string) {
    text = text.trim()

    if (isCertForgeHomepage(text)) {
      setCertForgeId('')
      setCertForgePromptOpen(true)
      return
    }

    if (await handleCertificateHandoff(text)) return

    if (isLegacyCredentialRequest(text)) {
      const params = legacyRequestParamsFromUrl(text)
      return goToCredentialFoyer(params)
    }

    if (isInteractionUrl(text)) {
      return redirectInteractionUrl(text)
    }

    if (isDeepLink(text)) {
      return redirectRequestRoute(text)
    }

    if (isWalletApiMessage(text)) {
      // A Wallet API Request JSON object has been pasted
      const message = parseWalletApiMessage({ messageObject: JSON.parse(text) })
      return navigationRef.navigate('ExchangeCredentialsNavigation', {
        screen: 'ExchangeCredentials',
        params: { message }
      })
    } else {
      // A direct URL to a credential or raw VC/VP JSON has been pasted
      const credentials = await credentialsFrom(text)
      await goToCredentialFoyerWith(credentials)
    }
  }

  async function addFromFile() {
    let fileContents = ''
    try {
      fileContents = await pickAndReadFile()
      await addCredentialsFrom(fileContents)
    } catch (err) {
      if (errorMessageMatches(err, CANCEL_PICKER_MESSAGES)) return

      const certForgeId = certForgeIdPrintedInText(fileContents)
      if (certForgeId) {
        try {
          await addCredentialsFrom(certForgeId)
          return
        } catch (lookupError) {
          err = lookupError
        }
      } else {
        const certificateUrl = learningCertificateUrlPrintedInText(fileContents)
        if (certificateUrl) {
          try {
            await addCredentialsFrom(certificateUrl)
            return
          } catch (urlError) {
            err = urlError
          }
          console.error(err)
          await displayGlobalModal({
            title: 'Unable to Add Credentials',
            body:
              err instanceof Error
                ? err.message
                : 'Udemy could not resolve this certificate ID.',
            cancelButton: false,
            confirmText: 'Close'
          })
          return
        }
        await displayGlobalModal({
          title: 'Certificate File Not Recognized',
          body: 'For Udemy, choose the certificate PDF or paste its public URL or full UC-… ID. Android reads scanned PDF pages automatically. For SAP, choose a selectable-text certificate PDF or paste its public Credly badge URL. Open Badges JSON/PNG files can also be imported.',
          cancelButton: false,
          confirmText: 'Close'
        })
        return
      }

      console.error(err)
      await displayGlobalModal({
        title: 'Unable to Add Credentials',
        body:
          err instanceof Error
            ? err.message
            : 'Paste a Udemy certificate URL or SAP Credly badge URL, or choose a credential JSON, JWT, or baked Open Badges PNG file.',
        cancelButton: false,
        confirmText: 'Close'
      })
    }
  }

  async function addFromTextbox() {
    try {
      await addCredentialsFrom(inputValue)
    } catch (err) {
      console.error(err)
      await displayGlobalModal({
        title: 'Unable to Add Credentials',
        body: err instanceof Error ? err.message : 'Contents not recognized.',
        cancelButton: false,
        confirmText: 'Close'
      })
    }
  }

  async function onReadQRCode(text: string) {
    AccessibilityInfo.announceForAccessibility('QR Code Scanned')

    if (isCertForgeHomepage(text)) {
      navigationRef.goBack()
      setCertForgeId('')
      setCertForgePromptOpen(true)
      return
    }

    try {
      await addCredentialsFrom(text)
    } catch (err) {
      console.warn(err)

      if (
        err instanceof Error &&
        err.message === 'No credentials were resolved from the text'
      ) {
        throw new HumanReadableError(
          'This QR does not contain a supported credential. Use a signed demo QR from Settings → Offline Demo Organizations.'
        )
      }

      if (
        err instanceof Error &&
        (err.message.startsWith('CertForge') ||
          err.message.startsWith('This CertForge'))
      ) {
        throw new HumanReadableError(err.message)
      }

      if (
        err instanceof Error &&
        (err.message.startsWith('This QR opens an issuer webpage') ||
          err.message.startsWith('This badge page did not provide'))
      ) {
        throw new HumanReadableError(err.message)
      }

      if (errorMessageMatches(err, Object.values(PresentationError))) {
        throw new HumanReadableError(err.message)
      } else {
        throw new HumanReadableError(
          'An error was encountered when parsing this QR code.'
        )
      }
    }
  }

  return (
    <>
      <NavHeader title="Add Credential" />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        <Motion style={styles.container}>
          <ScreenIntro
            eyebrow="GROW YOUR COLLECTION"
            title="Make room for your next achievement."
            description="Scan, upload, or paste a link to bring your next credential into your wallet."
            icon="add-card"
          />
          <Button
            title="Scan QR code"
            buttonStyle={mixins.buttonIcon}
            containerStyle={[mixins.buttonIconContainer, mixins.noFlex]}
            titleStyle={mixins.buttonIconTitle}
            iconRight
            onPress={onPressQRScreen}
            icon={
              <MaterialIcons
                name="qr-code-scanner"
                size={theme.iconSize}
                color={theme.color.iconInactive}
              />
            }
          />
          <Button
            title="Add from file"
            buttonStyle={mixins.buttonIcon}
            containerStyle={[mixins.buttonIconContainer, mixins.noFlex]}
            titleStyle={mixins.buttonIconTitle}
            iconRight
            onPress={addFromFile}
            testID="add-from-file-button"
            icon={
              <MaterialCommunityIcons
                name="file-upload"
                size={theme.iconSize}
                color={theme.color.iconInactive}
              />
            }
          />
          <View style={styles.sectionContainer}>
            <View style={styles.actionInputContainer}>
              <TextInput
                autoCapitalize="none"
                multiline
                value={inputValue}
                onChangeText={setInputValue}
                style={styles.input}
                outlineColor={theme.color.iconInactive}
                selectionColor={theme.color.textPrimary}
                theme={{
                  roundness: theme.borderRadius,
                  colors: {
                    placeholder: theme.color.textSecondary,
                    text: theme.color.textPrimary,
                    primary: theme.color.brightAccent
                  }
                }}
                label="Paste JSON, Udemy URL, SAP Credly URL, or CertForge ID"
                mode="outlined"
                keyboardAppearance={theme.keyboardAppearance}
                onTextInput={() => {}}
                tvParallaxProperties={undefined}
                testID="paste-json-input"
              />
              <Button
                title="Add"
                buttonStyle={[
                  mixins.button,
                  mixins.buttonPrimary,
                  styles.actionButton
                ]}
                containerStyle={[
                  mixins.buttonContainer,
                  styles.actionButtonContainer
                ]}
                titleStyle={[mixins.buttonTitle]}
                onPress={addFromTextbox}
                disabled={!inputIsValid}
                disabledStyle={styles.actionButtonInactive}
                disabledTitleStyle={styles.actionButtonInactiveTitle}
                testID="add-credential-button"
              />
            </View>
          </View>
        </Motion>
      </ScrollView>
      <ConfirmModal
        open={certForgePromptOpen}
        title="Enter CertForge ID"
        confirmText="Find certificate"
        cancelText="Cancel"
        confirmButtonDisabled={certForgeId.trim().length === 0}
        onRequestClose={() => setCertForgePromptOpen(false)}
        onCancel={() => setCertForgePromptOpen(false)}
        onConfirm={() => {
          const id = certForgeId.trim()
          setCertForgePromptOpen(false)
          void addCredentialsFrom(id).catch(async (error) => {
            await displayGlobalModal({
              title: 'Unable to Find Certificate',
              body:
                error instanceof Error
                  ? error.message
                  : 'CertForge could not return a verified credential.',
              cancelButton: false,
              confirmText: 'Close'
            })
          })
        }}
      >
        <Text style={mixins.modalBodyText}>
          Enter the CertForge ID printed on the certificate. For Udemy, paste
          the public certificate URL; for SAP, paste the Credly public badge
          URL. JSON, JWT, or baked badge PNG files can be imported directly.
        </Text>
        <TextInput
          autoCapitalize="characters"
          autoCorrect={false}
          value={certForgeId}
          onChangeText={setCertForgeId}
          label="Certificate ID"
          mode="outlined"
          placeholder="CF-2026-XXXXXXXX"
          testID="certforge-id-input"
          onTextInput={() => {}}
          tvParallaxProperties={undefined}
        />
      </ConfirmModal>
    </>
  )
}
