-- F4 — contact acquisition for volume outreach.
--
-- Operator scope decision: 1,000-2,000 verified contacts, two tiers.
--   Tier A (the engine, and the only tier F4 exercises): role aliases and published
--          HR contacts read off the employer's own pages through FetchPolicyGate.
--   Tier B (seam only in F4): named employees at any level EXCEPT founders, CEOs,
--          C-suite and VPs. handover.md §1.1 is NOT amended.
--
--   contact_type += named_employee            Tier B's non-Talent case.
--   outreach_case += intern_availability_inquiry   Part C's fourth case, checked LAST
--                                             so case 3 still wins where an
--                                             application exists.
--   contact.verified                          An UNVERIFIED contact opens no outreach
--                                             case. This is what makes pattern
--                                             inference safe to expose behind a flag.
--   contact.discovery_method                  Per-row, so bounce analysis can separate
--                                             page-published from provider-returned
--                                             from pattern-inferred rather than
--                                             averaging them.
--   contact.source_page_kind                  Which page kind yielded a Tier A address.
--                                             Answers the question nobody had data for:
--                                             is a paid lookup provider worth buying?
--
-- Generated with `prisma migrate diff --from-config-datasource --to-schema`, reviewed
-- by hand, applied with `migrate deploy`. Checked for DROP: none. `prisma db push` is
-- banned — it offers to drop D3's partial unique indexes (A2).

-- CreateEnum
CREATE TYPE "contact_discovery_method" AS ENUM ('page_published', 'lookup_provider', 'pattern_inferred');

-- CreateEnum
CREATE TYPE "contact_source_page_kind" AS ENUM ('careers', 'contact', 'job_posting', 'footer', 'other');

-- AlterEnum
ALTER TYPE "contact_type" ADD VALUE 'named_employee';

-- AlterEnum
ALTER TYPE "outreach_case" ADD VALUE 'intern_availability_inquiry';

-- AlterTable
ALTER TABLE "contact" ADD COLUMN     "discovery_method" "contact_discovery_method" NOT NULL,
ADD COLUMN     "source_page_kind" "contact_source_page_kind",
ADD COLUMN     "verified" BOOLEAN NOT NULL DEFAULT false;

