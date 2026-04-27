-- 080: Verified caller auto-verification notification claim slot
--
-- Adds a single bookkeeping column the new VerifiedCallerSyncScheduler
-- uses to atomically claim the right to send the one-shot
-- `trusted_caller_verified` in-app notification on the
-- pending → verified transition.
--
-- Why a separate column from `verified_at`?
--   `verified_at` is set by `confirmCallerIdVerified` and is the source
--   of truth for "is this caller verified". The notification claim must
--   be a separate atomic gate so two concurrent scheduler instances
--   (e.g. blue/green deploy overlap) cannot both observe the row as
--   pending, both call `syncCallerIdStatus`, both see the resulting
--   verified row, and both send a duplicate success toast.
--
--   The claim column is set inside an atomic UPDATE with a
--   `verified_notification_sent_at IS NULL` guard, mirroring the
--   `expiry_alert_sent_at` slot pattern used by
--   `claimExpiryAlertSlot` for the weekly health-check alerts.

ALTER TABLE verified_caller_ids
  ADD COLUMN IF NOT EXISTS verified_notification_sent_at TIMESTAMPTZ;
