-- Per-user notification preferences.
-- A teammate can mute a notification *category* (call, billing, sms,
-- integration, escalation) on a specific *channel* (in_app, email)
-- without affecting their teammates.
--
-- Default behaviour is preserved: when no row exists for a given
-- (user, category, channel) tuple the channel is considered enabled.
-- Only explicit FALSE rows suppress delivery.
CREATE TABLE IF NOT EXISTS user_notification_preferences (
  user_id    VARCHAR     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category   VARCHAR(32) NOT NULL,
  channel    VARCHAR(16) NOT NULL,
  enabled    BOOLEAN     NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMP   NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, category, channel)
);

CREATE INDEX IF NOT EXISTS idx_user_notification_prefs_user
  ON user_notification_preferences(user_id);
