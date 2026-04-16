DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sms_conv_status_check') THEN
    ALTER TABLE sms_conversations ADD CONSTRAINT sms_conv_status_check
      CHECK (status IN ('open', 'pending', 'closed', 'escalated', 'archived'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sms_conv_priority_check') THEN
    ALTER TABLE sms_conversations ADD CONSTRAINT sms_conv_priority_check
      CHECK (priority IN ('normal', 'high', 'urgent'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sms_msg_direction_check') THEN
    ALTER TABLE sms_messages ADD CONSTRAINT sms_msg_direction_check
      CHECK (direction IN ('inbound', 'outbound'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sms_activity_action_check') THEN
    ALTER TABLE sms_conversation_activity_log ADD CONSTRAINT sms_activity_action_check
      CHECK (action IN ('status_changed', 'assigned', 'note_added', 'message_sent', 'message_received', 'message_scheduled', 'priority_changed', 'pinned', 'unpinned', 'tagged', 'follow_up_set'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sms_consent_action_check') THEN
    ALTER TABLE sms_consent_log ADD CONSTRAINT sms_consent_action_check
      CHECK (action IN ('opt_in', 'opt_out', 'help_request'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_sms_conv_tenant_unread ON sms_conversations(tenant_id) WHERE unread_count > 0;
