-- 089_dispatch_en_route_template_tracking_url.sql
--
-- Make sure every dispatch tenant's en_route SMS template includes the
-- customer-facing booking-tracker link, so existing tenants pick it up
-- without having to hand-edit their template.
--
-- Two passes:
--   1. For tenants that already have an `en_route` template, append the
--      "Track your tech: {{tracking_url}}" line — but only if the body
--      doesn't already reference the token (idempotent: re-running the
--      migration won't double-append).
--   2. For tenants that have *used* dispatch (have at least one
--      dispatch_resource or dispatch_job) but never created an
--      SMS-capable (channel in 'sms','both') en_route template, seed a
--      sensible default SMS template that includes the link. We
--      explicitly ignore email-only en_route templates here: a tenant
--      that only emails the en_route notification today still has no
--      way to reach customers via SMS (and so no way to surface the
--      tracking link), so we want the seed to fire for them too. We
--      gate on "tenant actually uses dispatch" rather than seeding the
--      whole tenants table so we don't bury non-dispatch tenants in
--      template noise.
--
-- The token itself is registered in `server/admin-api/routes/dispatch.ts`
-- (see `publicTrackerUrl` and the `substitute()` chain in
-- `fireNotifications`). Migration 088 guarantees `dispatch_jobs.tracking_token`
-- is present and unique, so the substitution always produces a valid URL.

UPDATE dispatch_notification_templates
   SET body_template = body_template
                       || CASE WHEN right(body_template, 1) IN (E'\n', '') THEN '' ELSE E'\n' END
                       || E'\nTrack your tech: {{tracking_url}}',
       updated_at = NOW()
 WHERE trigger_event = 'en_route'
   AND channel IN ('sms', 'both')
   AND body_template NOT LIKE '%{{tracking_url}}%';

INSERT INTO dispatch_notification_templates (
  tenant_id, name, trigger_event, channel, subject, body_template, is_active
)
SELECT DISTINCT t.id,
       'En route (default)',
       'en_route',
       'sms',
       '',
       E'Hi {{contact_name}}, {{resource_name}} is on the way for your {{job_title}} appointment — ETA about {{eta_drive_minutes}} min ({{eta_arrival_time}}).\n\nTrack your tech: {{tracking_url}}',
       true
  FROM tenants t
 WHERE NOT EXISTS (
         SELECT 1 FROM dispatch_notification_templates d
          WHERE d.tenant_id = t.id
            AND d.trigger_event = 'en_route'
            AND d.channel IN ('sms', 'both')
       )
   AND (
         EXISTS (SELECT 1 FROM dispatch_resources r WHERE r.tenant_id = t.id)
         OR EXISTS (SELECT 1 FROM dispatch_jobs j WHERE j.tenant_id = t.id)
       );
