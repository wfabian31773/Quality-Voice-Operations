-- Allow a 'system' direction on support_ticket_replies so admin status changes
-- (e.g. "Resolved by admin@…") can be recorded inline in the ticket thread.

ALTER TABLE support_ticket_replies
  DROP CONSTRAINT IF EXISTS support_ticket_replies_direction_check;

ALTER TABLE support_ticket_replies
  ADD CONSTRAINT support_ticket_replies_direction_check
  CHECK (direction IN ('outbound', 'inbound', 'system'));
