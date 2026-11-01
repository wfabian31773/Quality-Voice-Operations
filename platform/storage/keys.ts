/**
 * Canonical object-key namespaces. Every product write (recordings, exports,
 * uploads, voice-preview cache) must go through these builders so S3, local
 * disk, and the Replit sidecar keep the same layout.
 */
export const storageKeys = {
  upload: (objectId: string) => `uploads/${objectId}`,
  recording: (tenantId: string, callSid: string) => `recordings/${tenantId}/${callSid}`,
  routeExport: (tenantId: string, exportId: string) => `dispatch-route-exports/${tenantId}/${exportId}.zip`,
  voicePreview: (hash: string) => `voice-previews/${hash}.mp3`,
  knowledgeDocument: (tenantId: string, documentId: string) => `knowledge/${tenantId}/${documentId}.pdf`,
} as const;
