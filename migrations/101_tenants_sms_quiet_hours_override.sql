-- Per-tenant SMS quiet-hours override (Task #990).
--
-- The platform-wide SMS quiet-hours window is the TCPA federal default
-- (08:00-21:00 in the recipient's local time), enforced by
-- platform/sms/SmsQuietHours.ts. Some states (e.g. FL HB 761) and several
-- enterprise customers want a stricter window that's never broader than
-- the federal default. This migration lets a tenant tighten the window
-- without ever loosening it past the federal floor.
--
-- Both columns are NULLable. The default behavior — both NULL — keeps
-- the federal default in force. Setting both to a tighter pair (e.g.
-- 09:00 / 20:00) clamps every outbound text path to that window. The
-- runtime helper additionally clamps any out-of-range values back into
-- the federal window so an accidental loosening (e.g. 06:00) cannot
-- weaken the platform protection.
--
-- We deliberately do NOT add a CHECK constraint that one column be set
-- when the other is, because the helper treats "missing" as "fall back
-- to the federal default" on a per-side basis (e.g. tightening only the
-- end is allowed). However, we do require the start to be strictly less
-- than the end when both are set, so an inverted window can't be saved.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS sms_quiet_hours_start TIME,
  ADD COLUMN IF NOT EXISTS sms_quiet_hours_end TIME;

ALTER TABLE tenants
  DROP CONSTRAINT IF EXISTS tenants_sms_quiet_hours_window_order;

ALTER TABLE tenants
  ADD CONSTRAINT tenants_sms_quiet_hours_window_order
  CHECK (
    sms_quiet_hours_start IS NULL
    OR sms_quiet_hours_end IS NULL
    OR sms_quiet_hours_start < sms_quiet_hours_end
  );
