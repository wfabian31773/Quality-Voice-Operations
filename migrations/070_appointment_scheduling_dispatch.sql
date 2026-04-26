-- Remember which scheduling integration (e.g. google-calendar, outlook-calendar)
-- received an `appointment.booked` event so that downstream lifecycle events
-- (`appointment.rescheduled`, `appointment.cancelled`, `appointment.no_show`)
-- can be routed to the same calendar.
--
-- The voice-gateway booking event carries `agentId` and `phoneNumberId`, which
-- ConnectorService.dispatchEvent uses to look up the per-target preferred
-- scheduling provider. Reschedule / cancel / no-show events are typically
-- emitted later (admin UI, cron jobs, calendar webhooks) and frequently lack
-- those identifiers, which would otherwise cause the dispatch layer to fan
-- out to every enabled scheduling integration. This ledger gives those
-- downstream events a deterministic way back to the original calendar.
--
-- Rows are written by ConnectorService after a successful scheduling dispatch
-- on `appointment.booked`. The lookup key is derived from the payload in this
-- order of preference:
--   1. payload.appointmentId
--   2. payload.callSid
--   3. `${payload.callerPhone}:${payload.appointmentDate}T${payload.appointmentTime}`
--      (or the equivalent from `payload.startTime`)
--
-- The same key derivation is applied at lookup time. (tenant_id, lookup_key)
-- is the natural primary key — re-bookings overwrite the previous entry so
-- the ledger always reflects the most recent booking decision.
CREATE TABLE IF NOT EXISTS appointment_scheduling_dispatch (
  tenant_id VARCHAR(255) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lookup_key VARCHAR(500) NOT NULL,
  scheduling_provider VARCHAR(60) NOT NULL,
  external_event_id VARCHAR(500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, lookup_key)
);

CREATE INDEX IF NOT EXISTS idx_appt_sched_dispatch_tenant
  ON appointment_scheduling_dispatch(tenant_id);

ALTER TABLE appointment_scheduling_dispatch ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_appt_sched_dispatch ON appointment_scheduling_dispatch;
CREATE POLICY tenant_isolation_appt_sched_dispatch ON appointment_scheduling_dispatch
  USING (tenant_id = current_setting('app.tenant_id', true)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::varchar);
