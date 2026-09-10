-- F4 — what a Draft needs to carry before a composer can write one.
--
-- Three gaps, all found while wiring §12.2 rather than by reading the schema.
--
--   draft.contact_id       The recipient, pinned on the artefact instead of read
--                          through the lead. F2 §4.15 keeps ONE Lead per company per
--                          cycle; the operator's §10.7 decision permits TWO contacts
--                          at a company with teamSize >= 100. Two drafts under one
--                          lead therefore have two different recipients, which
--                          Lead.contactId alone cannot express — and A7 hashes
--                          recipient_email_normalized, so the recipient must be a
--                          property of the thing the human approved.
--
--   draft.touch_slot       Which of the company's permitted first-touch slots this
--                          draft occupies: 0 always, 1 only when the company cleared
--                          the size threshold. F5 replaces
--                          one_first_touch_per_company_per_cycle with an index over
--                          this column (§10.7's SQL sketch), so the database keeps a
--                          hard ceiling of two rather than trusting policy code.
--
--   draft.composition      The message as SENTENCES with their citations, before
--                          rendering into body_text. D5's invariant is per-sentence,
--                          and once sentences are joined into a string, which
--                          citation supported which claim is unrecoverable — so
--                          "every personalization sentence cites evidence" would stop
--                          being checkable. This is prefilled_answers applied to a
--                          message.
--
--   draft.approved_claim_ids   The candidate side of the citation rule (F3 §4.1).
--                          Evidence bounds what may be said about the COMPANY;
--                          ApprovedClaim bounds what may be said about the CANDIDATE,
--                          and a draft asserts both in one sentence. Mirrors
--                          cited_evidence_ids so each axis is one query rather than a
--                          walk of the JSON.
--
-- The unique index stops the composer handing the operator two copies of the same
-- message to the same person. It is NOT A2's invariant: that one is about messages
-- reaching people and lives on send_attempt (D3), which F5 owns and which this does
-- not touch.
--
-- Generated with `prisma migrate diff --from-config-datasource --to-schema`, read by
-- hand, applied with `migrate deploy`. Checked for DROP: none. `prisma db push` is
-- banned — it offers to drop D3's partial unique indexes (A2).

-- AlterTable
ALTER TABLE "draft" ADD COLUMN     "approved_claim_ids" TEXT[],
ADD COLUMN     "composition" JSONB,
ADD COLUMN     "contact_id" TEXT,
ADD COLUMN     "touch_slot" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE UNIQUE INDEX "draft_lead_id_contact_id_touch_slot_key" ON "draft"("lead_id", "contact_id", "touch_slot");

-- AddForeignKey
ALTER TABLE "draft" ADD CONSTRAINT "draft_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
