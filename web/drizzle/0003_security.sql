-- Split the public referral code from a private status token, record hashed
-- signup metadata for fraud review, and back rate limiting with Postgres so
-- it works across serverless instances.

ALTER TABLE "waitlist" ADD COLUMN IF NOT EXISTS "status_token" text UNIQUE;
ALTER TABLE "waitlist" ADD COLUMN IF NOT EXISTS "signup_ip_hash" text;
ALTER TABLE "waitlist" ADD COLUMN IF NOT EXISTS "signup_user_agent" text;

CREATE INDEX IF NOT EXISTS "waitlist_status_token_idx" ON "waitlist" ("status_token");
CREATE INDEX IF NOT EXISTS "waitlist_signup_ip_hash_idx" ON "waitlist" ("signup_ip_hash");

CREATE TABLE IF NOT EXISTS "rate_limits" (
  "key" text NOT NULL,
  "window_start" timestamp with time zone NOT NULL,
  "count" integer DEFAULT 1 NOT NULL,
  PRIMARY KEY ("key", "window_start")
);
