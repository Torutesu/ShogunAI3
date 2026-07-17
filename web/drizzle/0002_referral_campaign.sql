ALTER TABLE "waitlist" ADD COLUMN IF NOT EXISTS "ref_code" text UNIQUE;
ALTER TABLE "waitlist" ADD COLUMN IF NOT EXISTS "referred_by" text;
ALTER TABLE "waitlist" ADD COLUMN IF NOT EXISTS "answer_time_sink" text;
ALTER TABLE "waitlist" ADD COLUMN IF NOT EXISTS "answer_company_role" text;
ALTER TABLE "waitlist" ADD COLUMN IF NOT EXISTS "answer_why" text;
ALTER TABLE "waitlist" ADD COLUMN IF NOT EXISTS "form_completed_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "waitlist_ref_code_idx" ON "waitlist" ("ref_code");
CREATE INDEX IF NOT EXISTS "waitlist_referred_by_idx" ON "waitlist" ("referred_by");
