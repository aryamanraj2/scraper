/**
 * The approval view: what the operator reads before `--approve`, one draft at a time.
 *
 * ## Why the recipient's title is the first line
 *
 * F6-DECISIONS §8, step 3. The verified lookup-provider rows include people the
 * operator would not write to — an IT asset manager is a real example — and the
 * executive filter deliberately does not catch them, because the boundary it enforces
 * is §1.1's (founders, C-suite, VPs), not "is this a recruiter or an engineer". That
 * judgment is the operator's, made per message at approval, so the title has to be the
 * first thing they see rather than something they scroll for.
 *
 * A missing title is printed as missing, never left blank: a blank line reads as
 * "nothing to check" when it means "nothing to see".
 *
 * **Only a named contact has a title.** On a page-published alias, `publicTitle` holds
 * whatever text the curator found next to the address. Measured on the live rows:
 * `"email":"`, a phone-number fragment, `log in to the FedMobile app now...`. Printed
 * as TITLE, that reads as a job. So an alias gets a TITLE line saying it is a role inbox,
 * and the page text goes on a line labelled for what it is. That line is still worth
 * reading: it is how the operator sees that an "alias" was lifted from a returns FAQ.
 */
export type ReviewDraft = {
  id: string
  status: string
  companyName: string
  touchSlot: number
  outreachCase: string | null
  subject: string | null
  bodyText: string | null
  contact: {
    emailNormalized: string
    publicTitle: string | null
    contactType: string
    discoveryMethod: string
  } | null
}

export function formatDraftForReview(d: ReviewDraft): string {
  const pageText = d.contact?.publicTitle?.trim() || null
  const isPerson = d.contact?.contactType.startsWith('named') ?? false
  const title = isPerson ? (pageText ?? '(no public title)').toUpperCase() : `(ROLE INBOX, NO PERSON: ${d.contact?.contactType ?? '?'})`
  const rule = '─'.repeat(72)
  return [
    rule,
    `TITLE    ${title}`,
    ...(!isPerson && pageText ? [`page     text beside the address: "${pageText}"`] : []),
    `to       ${d.contact?.emailNormalized ?? '(no recipient)'}  ·  ${d.contact?.contactType ?? '?'} via ${d.contact?.discoveryMethod ?? '?'}`,
    `company  ${d.companyName}  ·  slot ${d.touchSlot}  ·  ${d.outreachCase ?? '?'}  ·  ${d.status}`,
    `draft    ${d.id}`,
    '',
    `Subject: ${d.subject ?? ''}`,
    '',
    d.bodyText ?? '',
    '',
    `approve: npm run drafts:run -- --approve ${d.id} --by <you>`,
  ].join('\n')
}
