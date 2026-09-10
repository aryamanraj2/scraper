import { describe, expect, it } from 'vitest'
import {
  classifyLocal,
  extractEmails,
  isCompanyDomain,
  normalizeEmail,
} from '../../src/outreach/contacts/classify.js'
import { isExecutiveContact } from '../../src/outreach/contacts/executive-filter.js'

describe('email extraction', () => {
  it('finds addresses in ordinary careers-page prose', () => {
    const text = 'Questions? Write to careers@acme.com or talent@acme.com. We reply within a week.'
    expect(extractEmails(text).sort()).toEqual(['careers@acme.com', 'talent@acme.com'])
  })

  it('lower-cases, so the unique index and suppression hash agree', () => {
    expect(extractEmails('Careers@ACME.com')).toEqual(['careers@acme.com'])
    expect(normalizeEmail('  Careers@ACME.com ')).toBe('careers@acme.com')
  })

  it('drops mailboxes whose operators do not want unsolicited mail', () => {
    // RFC 2142 mailboxes and their neighbours. abuse@ and privacy@ receiving a cold
    // recruiting message is the worst outcome available from this code.
    const text =
      'noreply@acme.com no-reply@acme.com postmaster@acme.com abuse@acme.com ' +
      'privacy@acme.com dpo@acme.com legal@acme.com unsubscribe@acme.com billing@acme.com'
    expect(extractEmails(text)).toEqual([])
  })

  it('drops placeholder domains that only appear in templates', () => {
    expect(extractEmails('careers@example.com hello@yourcompany.com jobs@test.com')).toEqual([])
  })

  it('does not mistake asset filenames or srcset noise for addresses', () => {
    expect(extractEmails('logo@2x.png hero@3x.jpg icon@2x.svg')).toEqual([])
  })

  it('returns each address once however many times the page repeats it', () => {
    expect(extractEmails('careers@acme.com ... careers@acme.com ... CAREERS@acme.com')).toEqual([
      'careers@acme.com',
    ])
  })
})

describe('classification', () => {
  it('recognises university-recruiting aliases ahead of general careers ones', () => {
    for (const local of ['internships', 'campus', 'university-recruiting', 'earlycareers', 'newgrad']) {
      const c = classifyLocal(`${local}@acme.com`)
      expect(c.kind, local).toBe('alias')
      expect(c.kind === 'alias' && c.contactType, local).toBe('university_recruiting')
    }
  })

  it('recognises talent and careers aliases', () => {
    expect(classifyLocal('talent@acme.com')).toMatchObject({ contactType: 'talent_alias' })
    expect(classifyLocal('recruiting@acme.com')).toMatchObject({ contactType: 'talent_alias' })
    expect(classifyLocal('hr@acme.com')).toMatchObject({ contactType: 'talent_alias' })
    expect(classifyLocal('careers@acme.com')).toMatchObject({ contactType: 'careers_alias' })
    expect(classifyLocal('jobs@acme.com')).toMatchObject({ contactType: 'careers_alias' })
  })

  it('treats separators as noise, so talent-acquisition@ is still an alias', () => {
    expect(classifyLocal('talent.acquisition@acme.com').kind).toBe('alias')
    expect(classifyLocal('talent_acquisition@acme.com').kind).toBe('alias')
  })

  it('marks a generic company mailbox as a fallback route, not a first-class alias', () => {
    expect(classifyLocal('hello@acme.com').kind).toBe('fallback_alias')
    expect(classifyLocal('info@acme.com').kind).toBe('fallback_alias')
  })

  it('errs towards NAMED for anything it does not recognise', () => {
    // Misfiling a person as a role alias would mail an individual under Tier A's
    // looser rules. The reverse costs one skipped contact.
    for (const local of ['jane.doe', 'j.smith', 'priya', 'awilliams', 'unknownword']) {
      expect(classifyLocal(`${local}@acme.com`).kind, local).toBe('named')
    }
  })
})

describe('company-domain check', () => {
  it('accepts the domain and its subdomains', () => {
    expect(isCompanyDomain('careers@acme.com', 'acme.com')).toBe(true)
    expect(isCompanyDomain('careers@jobs.acme.com', 'acme.com')).toBe(true)
  })

  it('rejects a personal account and an unrelated employer', () => {
    // §1.2 forbids using a personal email; an address at another company is somebody
    // else's employee.
    expect(isCompanyDomain('someone@gmail.com', 'acme.com')).toBe(false)
    expect(isCompanyDomain('careers@othercorp.com', 'acme.com')).toBe(false)
    // Suffix trickery: notacme.com must not pass as a subdomain of acme.com.
    expect(isCompanyDomain('careers@notacme.com', 'acme.com')).toBe(false)
  })
})

describe('executive filter (handover.md §1.1)', () => {
  it('rejects executives by title', () => {
    for (const title of [
      'Founder',
      'Co-Founder & CEO',
      'Chief Technology Officer',
      'CTO',
      'CEO',
      'President',
      'Vice President, Engineering',
      'VP of People',
      'SVP Operations',
      'Managing Director',
      'Chairman',
      'Head of Engineering',
      'Head of Talent',
      'General Partner',
    ]) {
      expect(isExecutiveContact('someone@acme.com', title).isExecutive, title).toBe(true)
    }
  })

  it('rejects executives by local part when the page publishes no title at all', () => {
    // A contact page listing `founders@` with no role text must not pass just because
    // there was nothing to read.
    for (const local of ['founders', 'ceo', 'cto', 'exec', 'leadership', 'board', 'officeofthectO', 'vp.eng']) {
      expect(isExecutiveContact(`${local}@acme.com`, null).isExecutive, local).toBe(true)
    }
  })

  it('permits the non-executive employees the operator scope note allows', () => {
    for (const title of [
      'Software Engineer',
      'Senior Software Engineer',
      'Staff Engineer',
      'Engineering Manager',
      'Technical Recruiter',
      'University Recruiter',
      'Talent Partner Associate',
      'People Operations Coordinator',
    ]) {
      expect(isExecutiveContact('jane.doe@acme.com', title).isExecutive, title).toBe(false)
    }
  })

  it('separates a VC Partner from a recruiting Partner', () => {
    // "Partner" alone at a fund is an executive. "Talent Partner", "People Partner"
    // and "HR Business Partner" are IC recruiter titles — exactly who Tier B wants.
    expect(isExecutiveContact('a@acme.com', 'Partner').isExecutive).toBe(true)
    expect(isExecutiveContact('a@acme.com', 'General Partner').isExecutive).toBe(true)
    for (const title of [
      'Talent Partner',
      'Talent Partner Associate',
      'People Partner',
      'HR Business Partner',
      'Recruiting Partner',
    ]) {
      expect(isExecutiveContact('a@acme.com', title).isExecutive, title).toBe(false)
    }
  })

  it('does not fire on words that merely contain an executive token', () => {
    for (const title of ['Overhead Line Engineer', 'VPN Infrastructure Engineer', 'Presidential Scholar Program Lead']) {
      const v = isExecutiveContact('jane.doe@acme.com', title)
      expect(v.isExecutive, title).toBe(false)
    }
  })

  it('reports where the match came from, so a refusal is auditable', () => {
    const byTitle = isExecutiveContact('jane@acme.com', 'Chief People Officer')
    expect(byTitle).toMatchObject({ isExecutive: true, where: 'title' })
    const byLocal = isExecutiveContact('ceo@acme.com', null)
    expect(byLocal).toMatchObject({ isExecutive: true, where: 'local' })
  })
})
