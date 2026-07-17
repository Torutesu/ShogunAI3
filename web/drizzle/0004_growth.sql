-- Growth instrumentation: signup attribution (country via Cloudflare header,
-- UTM params, locale) and idempotent email notifications with opt-out.

ALTER TABLE "waitlist" ADD COLUMN IF NOT EXISTS "locale" text;
ALTER TABLE "waitlist" ADD COLUMN IF NOT EXISTS "signup_country" text;
ALTER TABLE "waitlist" ADD COLUMN IF NOT EXISTS "utm_source" text;
ALTER TABLE "waitlist" ADD COLUMN IF NOT EXISTS "utm_medium" text;
ALTER TABLE "waitlist" ADD COLUMN IF NOT EXISTS "utm_campaign" text;
ALTER TABLE "waitlist" ADD COLUMN IF NOT EXISTS "email_opt_out_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "waitlist_signup_country_idx" ON "waitlist" ("signup_country");
CREATE INDEX IF NOT EXISTS "waitlist_utm_source_idx" ON "waitlist" ("utm_source");

CREATE TABLE IF NOT EXISTS "notifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "waitlist_id" uuid NOT NULL REFERENCES "waitlist"("id"),
  "kind" text NOT NULL,
  "sent_at" timestamp with time zone DEFAULT now() NOT NULL,
  UNIQUE ("waitlist_id", "kind")
);
