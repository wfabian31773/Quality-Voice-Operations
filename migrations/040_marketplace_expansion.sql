DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'marketplace_category') THEN
    CREATE TYPE marketplace_category AS ENUM (
      'vertical_agent',
      'workflow_package',
      'integration_connector',
      'prompt_pack',
      'analytics_pack'
    );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'price_model') THEN
    CREATE TYPE price_model AS ENUM (
      'free',
      'one_time',
      'monthly_subscription',
      'usage_based'
    );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'submission_status') THEN
    CREATE TYPE submission_status AS ENUM (
      'draft',
      'submitted',
      'in_review',
      'approved',
      'rejected',
      'published'
    );
  END IF;
END $$;

ALTER TABLE template_registry
  ADD COLUMN IF NOT EXISTS marketplace_category marketplace_category DEFAULT 'vertical_agent',
  ADD COLUMN IF NOT EXISTS price_model price_model DEFAULT 'free',
  ADD COLUMN IF NOT EXISTS price_cents INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stripe_price_id TEXT,
  ADD COLUMN IF NOT EXISTS developer_id TEXT,
  ADD COLUMN IF NOT EXISTS developer_name TEXT,
  ADD COLUMN IF NOT EXISTS developer_revenue_share_pct NUMERIC(5,2) DEFAULT 70.00,
  ADD COLUMN IF NOT EXISTS avg_rating NUMERIC(3,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS review_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS featured BOOLEAN DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS marketplace_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  template_id VARCHAR NOT NULL REFERENCES template_registry(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  review_text TEXT,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'flagged', 'removed')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, user_id, template_id)
);

CREATE INDEX IF NOT EXISTS idx_marketplace_reviews_template ON marketplace_reviews(template_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_reviews_tenant ON marketplace_reviews(tenant_id);

CREATE TABLE IF NOT EXISTS marketplace_purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  template_id VARCHAR NOT NULL REFERENCES template_registry(id) ON DELETE CASCADE,
  stripe_payment_id TEXT,
  stripe_checkout_session_id TEXT,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT DEFAULT 'usd',
  price_model price_model DEFAULT 'one_time',
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed', 'refunded')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_marketplace_purchases_tenant ON marketplace_purchases(tenant_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_purchases_template ON marketplace_purchases(template_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_purchases_stripe ON marketplace_purchases(stripe_checkout_session_id);

CREATE TABLE IF NOT EXISTS developer_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  developer_id TEXT NOT NULL,
  developer_name TEXT NOT NULL,
  developer_email TEXT NOT NULL,
  package_name TEXT NOT NULL,
  package_slug TEXT NOT NULL,
  marketplace_category marketplace_category NOT NULL DEFAULT 'vertical_agent',
  description TEXT NOT NULL,
  short_description TEXT,
  version TEXT NOT NULL DEFAULT '1.0.0',
  price_model price_model DEFAULT 'free',
  price_cents INTEGER DEFAULT 0,
  manifest JSONB NOT NULL DEFAULT '{}',
  status submission_status DEFAULT 'draft',
  review_notes TEXT,
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  template_id VARCHAR REFERENCES template_registry(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_developer_submissions_status ON developer_submissions(status);
CREATE INDEX IF NOT EXISTS idx_developer_submissions_developer ON developer_submissions(developer_id);

CREATE TABLE IF NOT EXISTS marketplace_revenue_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id UUID REFERENCES marketplace_purchases(id),
  template_id VARCHAR NOT NULL REFERENCES template_registry(id),
  developer_id TEXT,
  gross_amount_cents INTEGER NOT NULL DEFAULT 0,
  platform_fee_cents INTEGER NOT NULL DEFAULT 0,
  developer_share_cents INTEGER NOT NULL DEFAULT 0,
  event_type TEXT DEFAULT 'sale' CHECK (event_type IN ('sale', 'refund', 'subscription_renewal')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_marketplace_revenue_template ON marketplace_revenue_events(template_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_revenue_developer ON marketplace_revenue_events(developer_id);
