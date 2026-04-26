CREATE INDEX IF NOT EXISTS idx_ticket_sla_instances_ticket_created_at_desc
  ON ticket_sla_instances (ticket_id, created_at DESC);
