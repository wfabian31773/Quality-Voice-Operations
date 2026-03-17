ALTER TABLE call_sentiment_scores ADD CONSTRAINT uq_sentiment_per_call UNIQUE (tenant_id, call_session_id);
ALTER TABLE call_topic_classifications ADD CONSTRAINT uq_topic_per_call UNIQUE (tenant_id, call_session_id);
