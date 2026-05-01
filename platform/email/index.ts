export { sendEmail } from './EmailService';
export type { EmailMessage, EmailResult } from './EmailService';
export { normaliseMessageId } from './deliveryWebhookParser';
export { invitationEmail, passwordResetEmail, billingAlertEmail, planRecommendationEmail, emailVerificationEmail, connectorSyncErrorEmail, connectorSyncRecoveryEmail, connectorAutoDisabledEmail, connectorReconnectNeededEmail, connectorTokenExpiringEmail, connectorSyncDigestEmail, connectorSchedulingDriftEmail, escalationAlertEmail, verifiedCallerExpiringEmail, verifiedCallerRevokedEmail, verifiedCallerTrustHubRejectedEmail, encryptionInitializationReminderEmail, dispatchRouteExportReadyEmail, dispatchRouteExportFailedEmail, dispatchCompletionPhotosEmail, recommendationDirectionDigestEmail } from './templates';
