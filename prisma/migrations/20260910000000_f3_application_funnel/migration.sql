-- F3 — the application funnel.
--
-- Generated with `prisma migrate diff --from-config-datasource --to-schema`, then
-- reviewed by hand. `prisma migrate dev` could not run non-interactively here, and
-- `prisma db push` is banned outright: it reports D3's two partial unique indexes as
-- drift and offers to drop them, which is what lets one careers@ alias receive four
-- first-touch emails in a cycle (A2). The diff above was checked to contain no DROP.
--
--   lead_status += accepted, deferred   Part F's review outcomes (accept/defer/reject).
--   approved_claim.key                  idempotent seeding; nothing may key off `text`.
--   approved_claim.source_ref           which document the candidate fact came from.
--   application_packet.lead_id          the lead a packet was generated from; F4's
--                                       outreach predicate reads back through it.
--   application_packet.approved_claim_ids  the candidate-fact axis of provenance,
--                                       mirroring cited_evidence_ids.
--   application_packet.packet_hash      frozen at accept over A7's field shape, so the
--   application_packet.accepted_at      approved artefact stays immutable for F4.
--   (opportunity_id, resume_version_id) unique — "one packet per (opportunity, resume
--                                       version)"; regeneration updates, never forks.
--   llm_task.allowed_approved_claim_ids the ApprovedClaim analogue of
--                                       allowed_approved_evidence_ids: Evidence bounds
--                                       what may be said about the company, ApprovedClaim
--                                       bounds what may be said about the candidate.

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "lead_status" ADD VALUE 'accepted';
ALTER TYPE "lead_status" ADD VALUE 'deferred';

-- AlterTable
ALTER TABLE "application_packet" ADD COLUMN     "accepted_at" TIMESTAMP(3),
ADD COLUMN     "approved_claim_ids" TEXT[],
ADD COLUMN     "lead_id" TEXT,
ADD COLUMN     "packet_hash" TEXT;

-- AlterTable
ALTER TABLE "approved_claim" ADD COLUMN     "key" TEXT NOT NULL,
ADD COLUMN     "source_ref" TEXT;

-- AlterTable
ALTER TABLE "llm_task" ADD COLUMN     "allowed_approved_claim_ids" TEXT[];

-- CreateIndex
CREATE INDEX "application_packet_lead_id_idx" ON "application_packet"("lead_id");

-- CreateIndex
CREATE UNIQUE INDEX "application_packet_opportunity_id_resume_version_id_key" ON "application_packet"("opportunity_id", "resume_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "approved_claim_key_key" ON "approved_claim"("key");

-- CreateIndex
CREATE INDEX "approved_claim_category_is_active_idx" ON "approved_claim"("category", "is_active");

-- AddForeignKey
ALTER TABLE "application_packet" ADD CONSTRAINT "application_packet_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

