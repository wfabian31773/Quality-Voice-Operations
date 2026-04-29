-- 098_tenants_dispatch_completion_photo_email.sql
--
-- Per-tenant opt-out for the customer-facing "your job is done — here are
-- the photos" email. When `fireNotifications('completed')` runs and the
-- job has at least one `proof_of_completion` attachment, the dispatch
-- pipeline now also sends the customer a templated email with
-- tenant-scoped, time-limited links to each photo (see
-- `platform/dispatch/completionPhotoToken.ts` for the HMAC scheme and
-- `server/admin-api/routes/dispatch.ts:sendCompletionPhotosEmail`).
--
-- Default TRUE because the existing dispatch flows (SMS templates,
-- public booking-tracker link, etc.) already establish that customers
-- expect transactional updates after they book a job. A tenant that
-- specifically wants to suppress the photo email — e.g. because the
-- photos contain sensitive on-site detail their compliance team needs
-- to review first — flips this to FALSE through PUT /dispatch/settings.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS dispatch_completion_photo_email_enabled BOOLEAN
    NOT NULL DEFAULT TRUE;
