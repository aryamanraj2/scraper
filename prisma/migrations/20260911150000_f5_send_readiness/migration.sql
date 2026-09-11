-- F5 — send readiness.
--
-- Generated with `prisma migrate diff --from-config-datasource --to-schema --script`,
-- read by hand, then extended below the generated block with the one change Prisma
-- cannot express: D3's company-level partial unique index is REPLACED rather than
-- kept.
--
-- This is the only migration in the project that intentionally drops an index, which
-- makes it the one where `db push`-style carelessness would be indistinguishable from
-- the intended change. Two drops appear below and they are not alike:
--
--   * `send_attempt_company_id_campaign_cycle_touch_number_idx` is a plain LOOKUP
--     index. It is dropped only because the composite widens to include touch_slot.
--     Nothing depends on it for correctness.
--   * `one_first_touch_per_company_per_cycle` is one of D3's two PARTIAL UNIQUE
--     indexes — a correctness invariant — and it is replaced in the same migration
--     by a strictly-bounded successor. It is never left absent.
--
-- `one_first_touch_per_contact_per_cycle` is untouched. That is A2's invariant (one
-- first touch per human per cycle, regardless of track) and nothing about the
-- operator's two-slot decision changes it.

-- AlterEnum
ALTER TYPE "reason_code" ADD VALUE 'recipient_not_owned';

-- DropIndex
DROP INDEX "send_attempt_company_id_campaign_cycle_touch_number_idx";

-- AlterTable
ALTER TABLE "draft" ADD COLUMN     "sender_identity" TEXT;

-- AlterTable
ALTER TABLE "research_budget" ADD COLUMN     "vendor_credits_cap" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "send_attempt" ADD COLUMN     "touch_slot" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "send_attempt_company_id_campaign_cycle_touch_number_touch_s_idx" ON "send_attempt"("company_id", "campaign_cycle", "touch_number", "touch_slot");

-- ---------------------------------------------------------------------------
-- D3 successor — hand-written, per docs/F5-HANDOVER.md §8.3 and F4 §10.7.
-- ---------------------------------------------------------------------------
--
-- D3 gave a company exactly one first touch per campaign cycle. The operator's
-- decision is one for a small company and two for a larger one, so the ceiling moves
-- from "one" to "one per allocated slot" — and it stays in the DATABASE rather than
-- moving into policy code, so that a bug in slot allocation cannot produce a third
-- message to a company. `src/outreach/draft/slots.ts` allocates only 0 and 1.
--
-- Ordering matters: the successor is created in the same transaction that drops the
-- predecessor, so there is no window in which a company has no ceiling at all.
DROP INDEX one_first_touch_per_company_per_cycle;

CREATE UNIQUE INDEX one_first_touch_per_company_slot_per_cycle
  ON send_attempt (company_id, campaign_cycle, touch_slot)
  WHERE touch_number = 1 AND status IN ('in_flight','sent');
