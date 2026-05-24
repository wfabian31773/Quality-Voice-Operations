-- 109_widen_call_sessions_caller_number.sql
--
-- Root cause: createCallSession() in server/voice-gateway/services/callPersistence.ts
-- writes encryptSensitiveField(callerNumber) into call_sessions.caller_number, but
-- that column was VARCHAR(20) — sized for a plaintext E.164 phone number. The
-- envelope-encrypted ciphertext is ~80+ chars (IV + auth tag + key id + base64
-- payload), so every inbound call's INSERT failed with
--   "value too long for type character varying(20)"
-- which caused createRealtimeSession() to throw, the WS handler to close the
-- stream, and Twilio to end the call with duration=0.
--
-- Fix: widen caller_number (and called_number, for symmetry / future encryption)
-- to TEXT. No data migration needed — existing plaintext values fit fine.

ALTER TABLE call_sessions
  ALTER COLUMN caller_number TYPE TEXT,
  ALTER COLUMN called_number TYPE TEXT;
