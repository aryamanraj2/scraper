-- D3: the uniqueness rules that matter.
--
-- These are PARTIAL unique indexes. Prisma cannot express a WHERE clause on an
-- index, so they are hand-written here and must survive every future migration.
--
-- Do NOT run `prisma db push` against this project. It compares the live database
-- against schema.prisma, sees these indexes as drift, and offers to drop them.
-- package.json deliberately exposes no db:push script. Use db:migrate.
--
-- A2 is the defect these fix: the handover keyed first-touch uniqueness on
-- (company_id, role_track, campaign_cycle), which with four role tracks lets one
-- careers@ alias legitimately receive four first-touch emails per cycle. The
-- invariant is about messages reaching people, so it belongs on send_attempt, not
-- on lead, and role track is a property of a message rather than a licence for
-- another one.

-- One first touch per human per cycle, regardless of track.
CREATE UNIQUE INDEX one_first_touch_per_contact_per_cycle
  ON send_attempt (contact_id, campaign_cycle)
  WHERE touch_number = 1 AND status IN ('in_flight','sent');

-- Independent company-level cooldown, so two published aliases at the same company
-- still yield one touch.
CREATE UNIQUE INDEX one_first_touch_per_company_per_cycle
  ON send_attempt (company_id, campaign_cycle)
  WHERE touch_number = 1 AND status IN ('in_flight','sent');
