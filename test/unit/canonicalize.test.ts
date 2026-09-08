import { describe, expect, it } from 'vitest'
import { canonicalizeDomain, sameCompanyDomain } from '../../src/ingest/domain/canonicalize.js'

/**
 * `Company.canonicalDomain` is the join key across every source, so an error here
 * merges two companies or splits one — silently, and in the data rather than in a
 * stack trace. handover.md §11 requires this unit-tested.
 */
describe('canonicalizeDomain', () => {
  it('strips scheme, www, port, path, query and trailing dot', () => {
    const inputs = [
      'https://www.example.com/careers?utm=1#top',
      'http://EXAMPLE.com',
      'example.com.',
      'www.example.com:8443/jobs',
      '  https://example.com  ',
    ]
    for (const input of inputs) {
      expect(canonicalizeDomain(input), input).toEqual({ ok: true, domain: 'example.com' })
    }
  })

  it('keeps a subdomain out of the key', () => {
    expect(canonicalizeDomain('https://careers.example.com')).toEqual({
      ok: true,
      domain: 'example.com',
    })
  })

  /**
   * The reason this module takes a public-suffix-list dependency at all. Under a
   * "last two labels" rule every one of these collapses to the suffix itself, so
   * every Indian company on .co.in becomes ONE Company row — in the market the
   * plan makes priority #1 (B7).
   */
  it('resolves multi-part public suffixes, which is why the PSL dependency exists', () => {
    expect(canonicalizeDomain('https://www.razorpay.co.in')).toEqual({ ok: true, domain: 'razorpay.co.in' })
    expect(canonicalizeDomain('https://foo.co.uk/careers')).toEqual({ ok: true, domain: 'foo.co.uk' })
    expect(canonicalizeDomain('https://bar.org.in')).toEqual({ ok: true, domain: 'bar.org.in' })
    expect(canonicalizeDomain('https://a.com.au')).toEqual({ ok: true, domain: 'a.com.au' })
  })

  it('does not merge two companies that share a public suffix', () => {
    expect(sameCompanyDomain('https://alpha.co.in', 'https://beta.co.in')).toBe(false)
    expect(sameCompanyDomain('https://alpha.co.in', 'http://www.alpha.co.in/jobs')).toBe(true)
  })

  /** PSL private section: a hosting provider is not a company. */
  it('keeps companies on a shared hosting suffix distinct', () => {
    expect(canonicalizeDomain('https://acme.github.io')).toEqual({ ok: true, domain: 'acme.github.io' })
    expect(sameCompanyDomain('https://acme.github.io', 'https://other.github.io')).toBe(false)
  })

  it('rejects junk rather than guessing', () => {
    const cases: Array<[string | null | undefined, string]> = [
      ['', 'empty'],
      [null, 'empty'],
      [undefined, 'empty'],
      ['   ', 'empty'],
      ['http://192.168.1.10/careers', 'ip_literal'],
      ['https://[2001:db8::1]/', 'ip_literal'],
      ['http://localhost:3000', 'localhost'],
      ['ftp://example.com', 'unparseable'],
      ['https://com', 'no_registrable_domain'],
    ]
    for (const [input, reason] of cases) {
      expect(canonicalizeDomain(input), String(input)).toEqual({ ok: false, reason })
    }
  })

  /**
   * A gated platform must never become a canonical domain: that row would earn a
   * `derived_company` allow entry and hand the crawler the host the denylist
   * exists to keep unreachable (handover.md §1.4).
   */
  it('refuses a denylisted host outright', () => {
    for (const input of [
      'https://www.linkedin.com/company/acme',
      'https://linkedin.com',
      'https://x.com/acme',
      'https://in.indeed.com/cmp/acme',
      'https://internshala.com/company/acme',
    ]) {
      expect(canonicalizeDomain(input), input).toEqual({ ok: false, reason: 'denied_host' })
    }
  })
})
