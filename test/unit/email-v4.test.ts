import { describe, expect, it } from 'vitest'
import { APPROVED_CLAIMS } from '../../src/apply/claims/claims-data.js'
import { factCheck } from '../../src/outreach/draft/email.js'
import { STYLE_EXAMPLES_V4 } from '../../src/outreach/draft/queue-draft.js'

const claim = new Map(APPROVED_CLAIMS.map((c) => [c.key, c.text]))
const source = (...keys: string[]) => keys.map((k) => claim.get(k) ?? `MISSING ${k}`).join(' \n ')

/** What each story paragraph of the style examples rests on: arc, does-both, domain fit. */
const ARC = source(
  'project.aquasense.grounding', 'project.aquasense.diagnosis', 'achievement.mlh_brainwave',
  'project.saldo.ios', 'achievement.swift_student_challenge',
)
const WANDR = source('project.wandr.siri_intent')
const SMARTOUT = source('experience.smartout.role', 'experience.smartout.app', 'experience.smartout.maps', 'experience.smartout.installs')

describe('factCheck (outreach_draft@4)', () => {
  it("passes the operator's own style examples against the claims they rest on", () => {
    for (const ex of STYLE_EXAMPLES_V4) {
      const [arc, wandr, fit] = ex.story
      expect(factCheck(arc!, ARC), `${ex.company} arc`).toEqual([])
      expect(factCheck(wandr!, WANDR), `${ex.company} wandr`).toEqual([])
      if (fit) expect(factCheck(fit, SMARTOUT), `${ex.company} fit`).toEqual([])
    }
  })

  it('catches an invented number, employer and link', () => {
    const airtel = source('experience.airtel.role', 'experience.airtel.openstack')
    expect(factCheck('At Bharti Airtel, I cut query latency by 40%.', airtel)).toEqual(['40%'])
    expect(factCheck('Before that, I interned at Google.', airtel)).toEqual(['Google'])
    expect(factCheck('See https://example.com/demo for it.', airtel)).toEqual(['https://example.com/demo'])
  })

  it('accepts the operator project links and skips sentence openers, contracted ones too', () => {
    expect(factCheck('Saldo (https://github.com/aryamanraj2/Saldo) keeps data private.', source('project.saldo.ios'))).toEqual([])
    expect(factCheck("It's read-only. That's the point.", source('experience.airtel.text_to_sql'))).toEqual([])
  })
})
