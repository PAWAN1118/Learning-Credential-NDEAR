//import React, { useContext } from 'react';
import React from 'react'
import { View, Text } from 'react-native'
import { MaterialIcons } from '@expo/vector-icons'
import moment from 'moment'

import { VerificationStatusCardProps } from './VerificationStatusCard.d'
import dynamicStyleSheet from './VerificationStatusCard.styles'
import { useDynamicStyles } from '../../hooks'
//import { DidRegistryContext } from '../../init/registries';
//import { issuerInRegistries } from '../../lib/issuerInRegistries';
import { getExpirationDate } from '../../lib/credentialValidityPeriod'

enum LogId {
  ValidSignature = 'valid_signature',
  Expiration = 'expiration',
  IssuerDIDResolves = 'registered_issuer',
  RevocationStatus = 'revocation_status',
  SuspensionStatus = 'suspension_status',
  SupportedFormat = 'supported_format'
}

export default function VerificationStatusCard({
  credential,
  verifyPayload
}: VerificationStatusCardProps): React.ReactElement {
  const { styles } = useDynamicStyles(dynamicStyleSheet)
  const expirationDate = getExpirationDate(credential)
  const hasExpirationDate = expirationDate !== undefined
  const supportedCredentialTypes = [
    'VerifiableCredential',
    'OpenBadgeCredential'
  ]
  const hasKnownType =
    Array.isArray(credential.type) &&
    credential.type.some((t: string) => supportedCredentialTypes.includes(t))

  const details =
    verifyPayload.result.log?.reduce<Record<string, boolean | undefined>>(
      (acc, log) => {
        acc[log.id] = log.valid
        return acc
      },
      {}
    ) || {}
  const credlyReason = verifyPayload.result.log.find(
    (log) =>
      log.id === LogId.ValidSignature &&
      log.error?.name === 'credly_hosted_assertion' &&
      typeof log.error?.message === 'string'
  )?.error?.message as string | undefined
  const udemyReason = verifyPayload.result.log.find(
    (log) =>
      log.error?.name === 'udemy_public_certificate' &&
      typeof log.error?.message === 'string'
  )?.error?.message as string | undefined
  const isUdemy = !!udemyReason

  const lastChecked = moment(verifyPayload.result.timestamp).format(
    'MMM D, YYYY h:mmA z'
  )

  if (verifyPayload.loading) {
    return (
      <View style={styles.container}>
        <Text style={styles.sectionTitle}>
          Credential Verification and Validation
        </Text>
        <Text style={styles.bodyText}>Verifying credential...</Text>
      </View>
    )
  }

  if (verifyPayload.error) {
    return (
      <View style={styles.container}>
        <Text style={styles.sectionTitle}>
          Credential Verification and Validation
        </Text>
        <Text style={styles.bodyText}>Error: {verifyPayload.error}</Text>
      </View>
    )
  }

  function getStatusProps(
    id: LogId,
    valid: boolean | undefined
  ): { message: string; status: 'positive' | 'warning' | 'negative' } {
    switch (id) {
      case LogId.ValidSignature: {
        if (isUdemy) {
          return {
            message:
              'Udemy completion certificates are checked against the public issuer page, not a cryptographic signature',
            status: 'warning'
          }
        }
        const isCredlyHosted = verifyPayload.result.log.some(
          (log) =>
            log.id === LogId.ValidSignature &&
            log.error?.name === 'credly_hosted_assertion'
        )
        return {
          message: isCredlyHosted
            ? valid
              ? 'has a current Credly-hosted Open Badges record (holder name came from the PDF)'
              : 'could not be confirmed by Credly'
            : valid === undefined
              ? 'signature status could not be determined'
              : valid
                ? 'has a valid signature'
                : verifyPayload.result.log.some(
                      (log) =>
                        log.id === LogId.ValidSignature &&
                        log.error?.name === 'no_proof'
                    )
                  ? 'is missing a digital signature'
                  : 'has an invalid signature',
          status:
            (valid === undefined || !valid) && isCredlyHosted
              ? 'warning'
              : valid === undefined && !isCredlyHosted
                ? 'warning'
                : valid
                  ? 'positive'
                  : 'negative'
        }
      }
      case LogId.IssuerDIDResolves: {
        if (isUdemy) {
          return {
            message: valid
              ? 'certificate ID and course title match Udemy’s public record'
              : 'could not be confirmed by Udemy’s public record',
            status: valid ? 'positive' : 'warning'
          }
        }
        const isCredlyHosted = verifyPayload.result.log.some(
          (log) =>
            log.id === LogId.IssuerDIDResolves &&
            log.error?.name === 'credly_hosted_assertion'
        )
        return {
          message: isCredlyHosted
            ? valid
              ? 'has been confirmed as SAP by Credly'
              : 'could not be confirmed as SAP by Credly'
            : valid
              ? 'has been issued by a known issuer'
              : "isn't in a known issuer registry",
          status: valid ? 'positive' : 'warning'
        }
      }
      case LogId.RevocationStatus:
        return {
          message:
            valid === undefined
              ? 'revocation status could not be checked'
              : valid
                ? 'has not been revoked'
                : 'has been revoked',
          status:
            valid === undefined ? 'warning' : valid ? 'positive' : 'negative'
        }
      case LogId.SuspensionStatus:
        return {
          message: valid ? 'has not been suspended' : 'has been suspended',
          status: valid ? 'positive' : 'negative'
        }
      case LogId.Expiration:
        return {
          message:
            valid === undefined
              ? 'expiration status could not be determined'
              : valid
                ? 'has not expired'
                : 'has expired',
          status: valid === undefined || !valid ? 'warning' : 'positive'
        }
      case LogId.SupportedFormat:
        return {
          message: valid
            ? 'is in a supported credential format'
            : 'is not a recognized credential type',
          status: valid ? 'positive' : 'negative'
        }
      default:
        return {
          message: 'Status unknown',
          status: 'warning'
        }
    }
  }

  function StatusRow({
    message,
    status
  }: {
    message: string
    status: 'positive' | 'warning' | 'negative'
  }) {
    const { styles } = useDynamicStyles(dynamicStyleSheet)

    const getIcon = () => {
      switch (status) {
        case 'positive':
          return (
            <MaterialIcons
              name="check-circle"
              size={20}
              color="green"
              style={styles.statusIcon}
            />
          )
        case 'negative':
          return (
            <MaterialIcons
              name="cancel"
              size={20}
              color="red"
              style={styles.statusIcon}
            />
          )
        case 'warning':
          return (
            <View style={styles.warningCircle}>
              <Text style={styles.warningText}>!</Text>
            </View>
          )
        default:
          return null
      }
    }

    return (
      <View style={styles.statusRow}>
        {getIcon()}
        <Text style={styles.statusText}>{message}</Text>
      </View>
    )
  }

  return (
    <View style={styles.container}>
      <Text style={styles.sectionTitle}>
        Credential Verification and Validation
      </Text>
      <Text style={styles.subTitle}>This credential:</Text>
      <StatusRow {...getStatusProps(LogId.SupportedFormat, hasKnownType)} />
      <StatusRow
        {...getStatusProps(LogId.ValidSignature, details[LogId.ValidSignature])}
      />
      {credlyReason ? (
        <Text style={styles.bodyText}>Credly check: {credlyReason}</Text>
      ) : null}
      {udemyReason ? (
        <Text style={styles.bodyText}>Udemy check: {udemyReason}</Text>
      ) : null}
      <StatusRow
        {...getStatusProps(
          LogId.IssuerDIDResolves,
          details[LogId.IssuerDIDResolves]
        )}
      />
      <StatusRow
        {...getStatusProps(
          LogId.RevocationStatus,
          details[LogId.RevocationStatus]
        )}
      />
      {/* <StatusRow {...getStatusProps(LogId.SuspensionStatus, details[LogId.SuspensionStatus])} /> */}
      {hasExpirationDate ? (
        <StatusRow
          {...getStatusProps(LogId.Expiration, details[LogId.Expiration])}
        />
      ) : (
        <StatusRow
          message="expiration status could not be determined"
          status="warning"
        />
      )}

      <Text style={styles.lastChecked}>Last Checked: {lastChecked}</Text>
    </View>
  )
}
