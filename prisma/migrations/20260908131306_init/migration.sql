-- CreateEnum
CREATE TYPE "company_status" AS ENUM ('discovered', 'normalized', 'researching', 'researched', 'insufficient_evidence', 'excluded');

-- CreateEnum
CREATE TYPE "lead_status" AS ENUM ('candidate', 'qualifying', 'qualified', 'rejected');

-- CreateEnum
CREATE TYPE "lead_kind" AS ENUM ('posted_role', 'speculative');

-- CreateEnum
CREATE TYPE "role_track_key" AS ENUM ('ios_android', 'ai_engineer', 'sde', 'swe');

-- CreateEnum
CREATE TYPE "opportunity_kind" AS ENUM ('published_role', 'speculative');

-- CreateEnum
CREATE TYPE "opportunity_status" AS ENUM ('open', 'stale', 'closed', 'unknown');

-- CreateEnum
CREATE TYPE "draft_status" AS ENUM ('composing', 'quality_gate', 'gate_failed', 'awaiting_approval', 'approved', 'scheduled', 'sending', 'sent', 'replied', 'bounced_hard', 'bounced_soft', 'opted_out', 'closed');

-- CreateEnum
CREATE TYPE "send_attempt_status" AS ENUM ('in_flight', 'sent', 'failed', 'aborted');

-- CreateEnum
CREATE TYPE "application_packet_status" AS ENUM ('prepared', 'submitted', 'acknowledged', 'interview', 'rejected', 'no_response');

-- CreateEnum
CREATE TYPE "outreach_case" AS ENUM ('speculative_no_posting', 'application_route_unclear', 'post_application_followup');

-- CreateEnum
CREATE TYPE "contact_type" AS ENUM ('careers_alias', 'talent_alias', 'university_recruiting', 'named_talent');

-- CreateEnum
CREATE TYPE "contact_status" AS ENUM ('active', 'suppressed', 'retired');

-- CreateEnum
CREATE TYPE "suppression_scope" AS ENUM ('contact', 'domain', 'global');

-- CreateEnum
CREATE TYPE "bounce_hardness" AS ENUM ('hard', 'soft');

-- CreateEnum
CREATE TYPE "evidence_source_type" AS ENUM ('yc', 'ats', 'aggregator', 'registry', 'company_page', 'hiring_board', 'social_api', 'browser_task', 'user_hint');

-- CreateEnum
CREATE TYPE "company_signal_type" AS ENUM ('yc_profile', 'job_posting', 'careers_page', 'remote_policy', 'funding_or_growth', 'engineering_blog', 'ats_job_count_delta');

-- CreateEnum
CREATE TYPE "host_policy_mode" AS ENUM ('allow', 'deny');

-- CreateEnum
CREATE TYPE "host_policy_origin" AS ENUM ('seed_static', 'derived_company', 'operator');

-- CreateEnum
CREATE TYPE "kill_switch_scope" AS ENUM ('global', 'domain', 'account');

-- CreateEnum
CREATE TYPE "audit_actor_type" AS ENUM ('system', 'user', 'worker');

-- CreateEnum
CREATE TYPE "reason_code" AS ENUM ('host_denied', 'robots_disallowed', 'terms_prohibited', 'rate_limited', 'budget_exhausted', 'approval_hash_mismatch', 'suppressed', 'profile_incomplete', 'stale_at_send', 'outreach_not_permitted', 'cap_exceeded', 'breaker_open', 'duplicate_contact', 'duplicate_company', 'sending_disabled', 'no_public_recruiting_route', 'executive_only_contact', 'outdated_role', 'weak_evidence', 'low_relevance', 'duplicate', 'legal_policy_mismatch', 'insufficient_evidence', 'hard_bounce', 'soft_bounce', 'opt_out', 'wrong_contact', 'replied', 'application_submitted', 'user_paused', 'source_unavailable', 'content_unchanged', 'injection_detected', 'kill_switch_global', 'kill_switch_domain', 'kill_switch_account', 'browser_needs_user', 'browser_blocked', 'browser_policy_rejected');

-- CreateTable
CREATE TABLE "evidence" (
    "id" TEXT NOT NULL,
    "company_id" TEXT,
    "source_url" TEXT NOT NULL,
    "source_type" "evidence_source_type" NOT NULL,
    "excerpt" VARCHAR(500) NOT NULL,
    "content_hash" TEXT NOT NULL,
    "observed_at" TIMESTAMP(3) NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "fetched_via" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "actor_type" "audit_actor_type" NOT NULL,
    "actor_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT,
    "reason_code" "reason_code",
    "cost_usd" DECIMAL(12,6),
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppression" (
    "id" TEXT NOT NULL,
    "email_hmac" TEXT NOT NULL,
    "scope" "suppression_scope" NOT NULL,
    "domain" TEXT,
    "reason_code" "reason_code" NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suppression_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "host_policy" (
    "id" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "mode" "host_policy_mode" NOT NULL,
    "origin" "host_policy_origin" NOT NULL,
    "include_subdomains" BOOLEAN NOT NULL DEFAULT true,
    "terms_prohibited" BOOLEAN NOT NULL DEFAULT false,
    "rate_delay_ms_override" INTEGER,
    "source_url" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "host_policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "robots_cache" (
    "id" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "parse_ok" BOOLEAN NOT NULL,
    "ttl_seconds" INTEGER NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL,
    "status_code" INTEGER,

    CONSTRAINT "robots_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_budget" (
    "id" TEXT NOT NULL,
    "company_id" TEXT,
    "period_month" TEXT NOT NULL,
    "credits_spent" INTEGER NOT NULL DEFAULT 0,
    "credits_cap" INTEGER NOT NULL,
    "billed_usd_spent" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "billed_usd_cap" DECIMAL(12,6) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "research_budget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "secret_record" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "alg" TEXT NOT NULL,
    "key_version" INTEGER NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "iv" BYTEA NOT NULL,
    "auth_tag" BYTEA NOT NULL,
    "dek_ciphertext" BYTEA NOT NULL,
    "dek_iv" BYTEA NOT NULL,
    "dek_auth_tag" BYTEA NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "secret_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kill_switch" (
    "id" TEXT NOT NULL,
    "scope" "kill_switch_scope" NOT NULL,
    "target" TEXT NOT NULL,
    "engaged" BOOLEAN NOT NULL DEFAULT false,
    "reason_code" "reason_code",
    "note" TEXT,
    "actor_id" TEXT NOT NULL,
    "engaged_at" TIMESTAMP(3),
    "released_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kill_switch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company" (
    "id" TEXT NOT NULL,
    "canonical_domain" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "legal_name" TEXT,
    "website" TEXT,
    "yc_id" TEXT,
    "yc_batch" TEXT,
    "countries" TEXT[],
    "locations" TEXT[],
    "team_size" INTEGER,
    "tags" TEXT[],
    "status" "company_status" NOT NULL DEFAULT 'discovered',
    "status_reason" "reason_code",
    "ats_slug" TEXT,
    "ats_board_token" TEXT,
    "careers_url" TEXT,
    "last_refreshed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_signal" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "evidence_id" TEXT NOT NULL,
    "signal_type" "company_signal_type" NOT NULL,
    "observed_at" TIMESTAMP(3) NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "numeric_value" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_signal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_track" (
    "id" TEXT NOT NULL,
    "key" "role_track_key" NOT NULL,
    "display_name" TEXT NOT NULL,
    "positive_keywords" TEXT[],
    "negative_keywords" TEXT[],
    "default_resume_version_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "role_track_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opportunity" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "role_track_id" TEXT,
    "kind" "opportunity_kind" NOT NULL,
    "status" "opportunity_status" NOT NULL DEFAULT 'unknown',
    "title" TEXT,
    "role_url" TEXT,
    "location" TEXT,
    "remote_evidence_id" TEXT,
    "posted_at" TIMESTAMP(3),
    "last_seen_at" TIMESTAMP(3) NOT NULL,
    "closed_at" TIMESTAMP(3),
    "external_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "opportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "email_normalized" TEXT NOT NULL,
    "contact_type" "contact_type" NOT NULL,
    "status" "contact_status" NOT NULL DEFAULT 'active',
    "public_title" TEXT,
    "evidence_id" TEXT NOT NULL,
    "captured_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_profile" (
    "id" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "location" TEXT,
    "availability_from" TIMESTAMP(3),
    "availability_to" TIMESTAMP(3),
    "work_authorization" TEXT,
    "links" JSONB,
    "signature" TEXT,
    "sender_identity" TEXT,
    "reply_to_email" TEXT,
    "is_complete" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "candidate_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resume_version" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "track_key" "role_track_key" NOT NULL,
    "link_url" TEXT NOT NULL,
    "file_path" TEXT,
    "file_sha256" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "resume_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approved_claim" (
    "id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approved_claim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_brief" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "facts" JSONB NOT NULL,
    "relevance_note" TEXT NOT NULL,
    "cited_evidence_ids" TEXT[],
    "prompt_version" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "research_brief_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "score_version" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "weights" JSONB NOT NULL,
    "thresholds" JSONB NOT NULL,
    "max_risk_deduction" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "frozen_until_sends" INTEGER NOT NULL DEFAULT 100,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "score_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "opportunity_id" TEXT,
    "contact_id" TEXT,
    "lead_kind" "lead_kind" NOT NULL,
    "status" "lead_status" NOT NULL DEFAULT 'candidate',
    "status_reason" "reason_code",
    "primary_track" "role_track_key" NOT NULL,
    "primary_track_reason" TEXT NOT NULL,
    "campaign_cycle" TEXT NOT NULL,
    "score" INTEGER,
    "risk_deduction" INTEGER,
    "score_components" JSONB,
    "score_version_id" TEXT,
    "cited_evidence_ids" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "draft" (
    "id" TEXT NOT NULL,
    "lead_id" TEXT NOT NULL,
    "research_brief_id" TEXT,
    "resume_version_id" TEXT,
    "status" "draft_status" NOT NULL DEFAULT 'composing',
    "status_reason" "reason_code",
    "subject" TEXT,
    "body_text" TEXT,
    "outreach_case" "outreach_case",
    "cited_evidence_ids" TEXT[],
    "prompt_version" TEXT,
    "approval_hash" TEXT,
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "gate_result" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "draft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "send_attempt" (
    "id" TEXT NOT NULL,
    "draft_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "campaign_cycle" TEXT NOT NULL,
    "touch_number" INTEGER NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "rfc822_message_id" TEXT NOT NULL,
    "status" "send_attempt_status" NOT NULL DEFAULT 'in_flight',
    "status_reason" "reason_code",
    "provider_message_id" TEXT,
    "provider_thread_id" TEXT,
    "attempted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reconciled_at" TIMESTAMP(3),

    CONSTRAINT "send_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_event" (
    "id" TEXT NOT NULL,
    "send_attempt_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "provider_code" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "raw" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reply" (
    "id" TEXT NOT NULL,
    "send_attempt_id" TEXT NOT NULL,
    "provider_message_id" TEXT NOT NULL,
    "classification" TEXT,
    "snippet" VARCHAR(500),
    "received_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reply_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bounce" (
    "id" TEXT NOT NULL,
    "send_attempt_id" TEXT NOT NULL,
    "hardness" "bounce_hardness" NOT NULL,
    "provider_code" TEXT,
    "diagnostic" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bounce_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opt_out" (
    "id" TEXT NOT NULL,
    "send_attempt_id" TEXT,
    "email_hmac" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "opt_out_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_packet" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "opportunity_id" TEXT,
    "resume_version_id" TEXT NOT NULL,
    "official_url" TEXT NOT NULL,
    "prefilled_answers" JSONB NOT NULL,
    "cited_evidence_ids" TEXT[],
    "status" "application_packet_status" NOT NULL DEFAULT 'prepared',
    "submitted_at" TIMESTAMP(3),
    "outcome_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "application_packet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_hint" (
    "id" TEXT NOT NULL,
    "raw_url" TEXT,
    "company_name" TEXT,
    "note" TEXT,
    "resolved_company_id" TEXT,
    "rejected_reason" "reason_code",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "lead_hint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "evidence_company_id_idx" ON "evidence"("company_id");

-- CreateIndex
CREATE INDEX "evidence_content_hash_idx" ON "evidence"("content_hash");

-- CreateIndex
CREATE INDEX "evidence_source_type_observed_at_idx" ON "evidence"("source_type", "observed_at");

-- CreateIndex
CREATE INDEX "audit_log_subject_type_subject_id_idx" ON "audit_log"("subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "audit_log_reason_code_created_at_idx" ON "audit_log"("reason_code", "created_at");

-- CreateIndex
CREATE INDEX "audit_log_created_at_idx" ON "audit_log"("created_at");

-- CreateIndex
CREATE INDEX "suppression_scope_idx" ON "suppression"("scope");

-- CreateIndex
CREATE UNIQUE INDEX "suppression_email_hmac_scope_key" ON "suppression"("email_hmac", "scope");

-- CreateIndex
CREATE UNIQUE INDEX "host_policy_host_key" ON "host_policy"("host");

-- CreateIndex
CREATE INDEX "host_policy_mode_idx" ON "host_policy"("mode");

-- CreateIndex
CREATE UNIQUE INDEX "robots_cache_host_key" ON "robots_cache"("host");

-- CreateIndex
CREATE UNIQUE INDEX "research_budget_company_id_key" ON "research_budget"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "research_budget_company_id_period_month_key" ON "research_budget"("company_id", "period_month");

-- CreateIndex
CREATE UNIQUE INDEX "secret_record_name_key" ON "secret_record"("name");

-- CreateIndex
CREATE UNIQUE INDEX "kill_switch_scope_target_key" ON "kill_switch"("scope", "target");

-- CreateIndex
CREATE UNIQUE INDEX "company_canonical_domain_key" ON "company"("canonical_domain");

-- CreateIndex
CREATE UNIQUE INDEX "company_yc_id_key" ON "company"("yc_id");

-- CreateIndex
CREATE INDEX "company_status_idx" ON "company"("status");

-- CreateIndex
CREATE INDEX "company_yc_batch_idx" ON "company"("yc_batch");

-- CreateIndex
CREATE INDEX "company_signal_company_id_signal_type_observed_at_idx" ON "company_signal"("company_id", "signal_type", "observed_at");

-- CreateIndex
CREATE UNIQUE INDEX "role_track_key_key" ON "role_track"("key");

-- CreateIndex
CREATE INDEX "opportunity_status_last_seen_at_idx" ON "opportunity"("status", "last_seen_at");

-- CreateIndex
CREATE UNIQUE INDEX "opportunity_company_id_external_id_key" ON "opportunity"("company_id", "external_id");

-- CreateIndex
CREATE INDEX "contact_company_id_status_idx" ON "contact"("company_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "contact_email_normalized_key" ON "contact"("email_normalized");

-- CreateIndex
CREATE INDEX "research_brief_company_id_idx" ON "research_brief"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "score_version_label_key" ON "score_version"("label");

-- CreateIndex
CREATE INDEX "lead_status_lead_kind_idx" ON "lead"("status", "lead_kind");

-- CreateIndex
CREATE INDEX "lead_company_id_campaign_cycle_idx" ON "lead"("company_id", "campaign_cycle");

-- CreateIndex
CREATE INDEX "draft_status_idx" ON "draft"("status");

-- CreateIndex
CREATE UNIQUE INDEX "send_attempt_idempotency_key_key" ON "send_attempt"("idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "send_attempt_rfc822_message_id_key" ON "send_attempt"("rfc822_message_id");

-- CreateIndex
CREATE INDEX "send_attempt_contact_id_campaign_cycle_touch_number_idx" ON "send_attempt"("contact_id", "campaign_cycle", "touch_number");

-- CreateIndex
CREATE INDEX "send_attempt_company_id_campaign_cycle_touch_number_idx" ON "send_attempt"("company_id", "campaign_cycle", "touch_number");

-- CreateIndex
CREATE INDEX "send_attempt_status_idx" ON "send_attempt"("status");

-- CreateIndex
CREATE INDEX "delivery_event_send_attempt_id_occurred_at_idx" ON "delivery_event"("send_attempt_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "reply_provider_message_id_key" ON "reply"("provider_message_id");

-- CreateIndex
CREATE INDEX "bounce_hardness_occurred_at_idx" ON "bounce"("hardness", "occurred_at");

-- CreateIndex
CREATE INDEX "opt_out_email_hmac_idx" ON "opt_out"("email_hmac");

-- CreateIndex
CREATE INDEX "application_packet_status_idx" ON "application_packet"("status");

-- AddForeignKey
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_budget" ADD CONSTRAINT "research_budget_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_signal" ADD CONSTRAINT "company_signal_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_signal" ADD CONSTRAINT "company_signal_evidence_id_fkey" FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_track" ADD CONSTRAINT "role_track_default_resume_version_id_fkey" FOREIGN KEY ("default_resume_version_id") REFERENCES "resume_version"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_role_track_id_fkey" FOREIGN KEY ("role_track_id") REFERENCES "role_track"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact" ADD CONSTRAINT "contact_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_brief" ADD CONSTRAINT "research_brief_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead" ADD CONSTRAINT "lead_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead" ADD CONSTRAINT "lead_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "opportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead" ADD CONSTRAINT "lead_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead" ADD CONSTRAINT "lead_score_version_id_fkey" FOREIGN KEY ("score_version_id") REFERENCES "score_version"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draft" ADD CONSTRAINT "draft_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draft" ADD CONSTRAINT "draft_research_brief_id_fkey" FOREIGN KEY ("research_brief_id") REFERENCES "research_brief"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draft" ADD CONSTRAINT "draft_resume_version_id_fkey" FOREIGN KEY ("resume_version_id") REFERENCES "resume_version"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "send_attempt" ADD CONSTRAINT "send_attempt_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "draft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "send_attempt" ADD CONSTRAINT "send_attempt_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "send_attempt" ADD CONSTRAINT "send_attempt_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_event" ADD CONSTRAINT "delivery_event_send_attempt_id_fkey" FOREIGN KEY ("send_attempt_id") REFERENCES "send_attempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reply" ADD CONSTRAINT "reply_send_attempt_id_fkey" FOREIGN KEY ("send_attempt_id") REFERENCES "send_attempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bounce" ADD CONSTRAINT "bounce_send_attempt_id_fkey" FOREIGN KEY ("send_attempt_id") REFERENCES "send_attempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opt_out" ADD CONSTRAINT "opt_out_send_attempt_id_fkey" FOREIGN KEY ("send_attempt_id") REFERENCES "send_attempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_packet" ADD CONSTRAINT "application_packet_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_packet" ADD CONSTRAINT "application_packet_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "opportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_packet" ADD CONSTRAINT "application_packet_resume_version_id_fkey" FOREIGN KEY ("resume_version_id") REFERENCES "resume_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
