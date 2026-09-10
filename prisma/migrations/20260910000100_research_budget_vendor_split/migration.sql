-- F2 §4.7 asked F3 to split research-credit accounting. `credits_spent` counts every
-- research unit and is what `checkBudget` enforces; `vendor_credits_spent` counts the
-- subset that consumed a PAID vendor allowance (Firecrawl). One ceiling, two counters:
-- a second cap would break Part G's "cap zero -> all research no-ops with
-- budget_exhausted", which only holds because the free tier is metered too.

-- AlterTable
ALTER TABLE "research_budget" ADD COLUMN     "vendor_credits_spent" INTEGER NOT NULL DEFAULT 0;

