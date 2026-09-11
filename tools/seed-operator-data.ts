#!/usr/bin/env tsx
/**
 * Loads the operator's own data: four role-tailored resumes and the approved claims
 * they rest on.
 *
 * `ResumeVersion` and `ApprovedClaim` were empty tables through F0-F2 on purpose —
 * `RoleTrack.defaultResumeVersionId` is the seam F2's seeder deliberately left null,
 * because which resume belongs to which track is operator data, not taxonomy. This is
 * where both enter the system.
 *
 * Touches no network. Reads the resume PDFs from disk to hash them, and nothing else.
 */
import 'dotenv/config'
import { prisma, disconnectPrisma } from '../src/core/db/client.js'
import { seedApprovedClaims } from '../src/apply/claims/seed-claims.js'
import { seedCandidateProfile } from '../src/apply/claims/seed-profile.js'
import { seedResumeVersions } from '../src/apply/resumes/seed-resumes.js'
import { env } from '../src/core/config/config.js'

const db = prisma()

const resumes = await seedResumeVersions(db)
console.log('\nResumeVersion')
console.log(`  ${resumes.created} created, ${resumes.updated} updated`)
console.log(`  tracks wired to a default: ${resumes.tracksWired.join(', ') || 'none'}`)
if (resumes.tracksWithoutDefault.length > 0) {
  console.log(`  ⚠ tracks with NO default resume: ${resumes.tracksWithoutDefault.join(', ')}`)
  console.log('    Packets for these tracks will be skipped — a wrong resume is worse than none.')
}
if (resumes.missingFiles.length > 0) {
  console.log(`  ⚠ ${resumes.missingFiles.length} file(s) not found on disk:`)
  for (const f of resumes.missingFiles) console.log(`      ${f}`)
  console.log('    The row is seeded without a hash; packetHash cannot pin the document.')
}
if (resumes.unhosted.length > 0) {
  console.log(`  ⚠ not hosted, so linkUrl is still a local path: ${resumes.unhosted.join(', ')}`)
  console.log('    H3: a draft LINKS the resume. A file:// URL is useless in an email.')
}

const claims = await seedApprovedClaims(db)
console.log('\nApprovedClaim')
console.log(`  ${claims.created} created, ${claims.updated} updated, ${claims.deactivated} deactivated`)
console.log(
  `  by category: ${Object.entries(claims.byCategory)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')}`,
)
if (claims.missingRequired.length > 0) {
  console.log(`  ⚠ not supplied by the operator: ${claims.missingRequired.join(', ')}`)
  console.log('    Questions needing these are left UNANSWERED on every packet.')
  console.log('    handover.md §8 forbids inventing a graduation date or an availability window.')
}

// D6 condition 3's row, derived from the claims above and from nothing else — there
// is deliberately no second source of candidate facts (F3 §4.1).
const profile = await seedCandidateProfile(db, { sendingAccount: env().GMAIL_SENDING_ACCOUNT })
console.log('\nCandidateProfile')
console.log(`  ${profile.created ? 'created' : 'updated'} from ApprovedClaim`)
if (profile.missingClaimKeys.length > 0) {
  console.log(`  ⚠ claims not found: ${profile.missingClaimKeys.join(', ')}`)
}
if (profile.complete) {
  console.log('  complete against the enumerated field list (D6 condition 3)')
} else {
  console.log(`  ⚠ INCOMPLETE — missing: ${profile.missingFields.join(', ')}`)
  console.log('    Every send will abort with profile_incomplete until these exist.')
}

await disconnectPrisma()
console.log('')
