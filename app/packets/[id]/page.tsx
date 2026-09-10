import { notFound } from 'next/navigation'
import { db } from '../../lib/db.js'
import { loadPacketRow } from '../../../src/apply/viewer/queues.js'
import {
  acceptPacketAction,
  deferLeadAction,
  markSubmittedAction,
  queueAnswersAction,
  recordOutcomeAction,
  rejectLeadAction,
} from '../../actions.js'

export const dynamic = 'force-dynamic'

/**
 * One packet, with everything `handover.md` §9 requires a queue row to expose:
 * score breakdown, all citations, role track, chosen resume, history, and the
 * accept/defer/reject controls.
 *
 * ## The evidence viewer and §16
 *
 * *"Browser-derived and API-derived facts must display identically in the evidence
 * viewer, including source, timestamp, excerpt, and confidence."*
 *
 * Every evidence card below is rendered by the same JSX with no branch on
 * `fetchedVia`. The tier is shown as a neutral label beside the source and the date —
 * visible, because D4 wants an auditor to see which tier produced a row, but never
 * styled, ordered or caveated differently. `projectEvidence` guarantees the data half
 * of that; this component is the presentation half.
 */
export default async function PacketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const packet = await loadPacketRow(db, id)
  if (!packet) notFound()

  const accepted = packet.acceptedAt !== null
  const submitted = packet.submittedAt !== null

  return (
    <>
      <div className="panel">
        <h2>
          {packet.companyName} · {packet.roleTitle ?? 'untitled posting'}
        </h2>
        <dl className="kv">
          <dt>Apply at</dt>
          <dd>
            <a href={packet.officialUrl} target="_blank" rel="noreferrer noopener">
              {packet.officialUrl}
            </a>
            <div className="note">
              The employer&rsquo;s own form, copied unchanged from the ATS feed. You submit it; this
              system never does (H8).
            </div>
          </dd>

          <dt>Resume to upload</dt>
          <dd>
            {packet.resumeLabel}
            <div className="note">
              <code>{packet.resumeFilePath ?? packet.resumeLinkUrl}</code>
              {packet.resumeSha256 ? ` · sha256 ${packet.resumeSha256.slice(0, 12)}…` : ' · not hashed'}
            </div>
          </dd>

          <dt>Track</dt>
          <dd>{packet.trackKey ?? 'no track on this posting'}</dd>

          <dt>Location</dt>
          <dd>
            {packet.roleLocation ?? '—'}
            <span className="note"> · company: {packet.countries.join(', ') || 'unmapped'}</span>
          </dd>

          <dt>Contact route</dt>
          <dd className="note">
            None. No <code>Contact</code> row exists before F4 — <code>handover.md</code> §1.2 makes
            F4 the first milestone permitted to create one. An application needs no contact.
          </dd>

          <dt>Approval fingerprint</dt>
          <dd className="note">
            {packet.packetHash ? <code>{packet.packetHash.slice(0, 24)}…</code> : '—'}
            {accepted ? ' · frozen at accept' : ' · not frozen until you accept'}
          </dd>
        </dl>
      </div>

      {/* --- review controls -------------------------------------------- */}
      <div className="panel">
        <h2>Review</h2>
        {!accepted && (
          <form className="actions">
            <button className="primary" formAction={acceptPacketAction.bind(null, packet.packetId)}>
              Accept — I&rsquo;ll apply
            </button>
            <button formAction={deferLeadAction.bind(null, packet.packetId, undefined)}>
              Defer
            </button>
            <button
              className="danger"
              formAction={rejectLeadAction.bind(null, packet.packetId, undefined, undefined)}
            >
              Reject
            </button>
            {packet.answers.unanswered.some((u) => u.questionKey === 'why_company') && (
              <button formAction={queueAnswersAction.bind(null, packet.packetId)}>
                Queue judgment answers
              </button>
            )}
          </form>
        )}
        {accepted && !submitted && (
          <form className="actions">
            <button className="primary" formAction={markSubmittedAction.bind(null, packet.packetId, undefined)}>
              I applied — record it
            </button>
            <div className="note" style={{ flexBasis: '100%' }}>
              Records <code>application_submitted</code> against the lead. That state stops cold
              outreach for this opportunity: Part C permits a follow-up only <em>after</em> an
              application exists, and F4&rsquo;s predicate reads it. Clicking this sends nothing.
            </div>
          </form>
        )}
        {submitted && (
          <form className="actions">
            <span className="tag good">applied {packet.submittedAt?.slice(0, 10)}</span>
            {(['acknowledged', 'interview', 'rejected', 'no_response'] as const).map((o) => (
              <button key={o} formAction={recordOutcomeAction.bind(null, packet.packetId, o, undefined)}>
                {o.replace('_', ' ')}
              </button>
            ))}
          </form>
        )}
      </div>

      {/* --- score reasons ---------------------------------------------- */}
      <div className="panel">
        <h2>
          Why this scored {packet.score.total ?? '—'} · {packet.score.scoreVersion ?? 'no version'}
        </h2>
        <p className="note">
          Primary track <strong>{packet.score.primaryTrack ?? '—'}</strong> —{' '}
          {packet.score.primaryTrackReason ?? 'no reason recorded'}
        </p>
        <div className="components">
          {packet.score.components.map((c) => (
            <div className="component" key={c.key}>
              <div className="head">
                <span>{c.key.replace(/_/g, ' ')}</span>
                <span>
                  {c.points} / {c.max}
                </span>
              </div>
              <div className="bar">
                <i style={{ width: `${c.max === 0 ? 0 : (c.points / c.max) * 100}%` }} />
              </div>
              {/* F2 wrote these sentences to be read by a human. This is where. */}
              <div className="why">{c.reason}</div>
            </div>
          ))}
        </div>
        {packet.score.risks.length > 0 && (
          <>
            <h2 style={{ marginTop: 18 }}>Risk deductions · −{packet.score.riskDeduction ?? 0}</h2>
            {packet.score.risks.map((r) => (
              <div className="why" key={r.key}>
                <span className="tag bad">−{r.points}</span> {r.reason}
              </div>
            ))}
          </>
        )}
        {packet.score.countryMapVersion && (
          <p className="note" style={{ marginTop: 12 }}>
            Country map <code>{packet.score.countryMapVersion}</code>. An unrecognised spelling
            resolves to null and is recorded as unmapped — never guessed.
          </p>
        )}
      </div>

      {/* --- answers ----------------------------------------------------- */}
      <div className="panel">
        <h2>Prefilled answers · {packet.answers.answers.length}</h2>
        <p className="note" style={{ marginBottom: 14 }}>
          Every answer cites at least one approved claim. An answer that cites none is refused at
          write time as a schema error, not flagged for review.
        </p>
        {packet.answers.answers.map((a) => (
          <div className="answer" key={a.questionKey}>
            <div className="q">{a.question}</div>
            <div className="a">{a.answer}</div>
            <div className="cites">
              <span className="tag">{a.source}</span>{' '}
              {a.approvedClaimIds
                .map((cid) => packet.claims.find((c) => c.id === cid)?.key ?? cid)
                .join(' · ')}
              {a.citedEvidenceIds.length > 0 && ` · ${a.citedEvidenceIds.length} evidence citation(s)`}
            </div>
          </div>
        ))}

        {packet.answers.unanswered.length > 0 && (
          <>
            <h2 style={{ marginTop: 20 }}>Left blank · {packet.answers.unanswered.length}</h2>
            {packet.answers.unanswered.map((u) => (
              <div className="answer blank" key={u.questionKey}>
                <div className="q">{u.question}</div>
                <div className="a">{u.reason}</div>
              </div>
            ))}
          </>
        )}
      </div>

      {/* --- evidence viewer (§16) --------------------------------------- */}
      <div className="panel">
        <h2>Evidence · {packet.evidence.length}</h2>
        {packet.evidence.length === 0 ? (
          <p className="note">
            No company evidence is cited by an answer yet. The deterministic answers are all about
            the candidate; company evidence arrives with the judgment answers.
          </p>
        ) : (
          packet.evidence.map((e) => (
            // One template for every tier. No branch on fetchedVia anywhere below.
            <div className="evidence" key={e.evidenceId}>
              <div className="meta">
                <a href={e.sourceUrl} target="_blank" rel="noreferrer noopener">
                  {e.sourceUrl}
                </a>
                <span className="tag">{e.sourceType}</span>
                <span className="tag">{e.fetchedViaLabel}</span>
                <span>{e.observedAt.slice(0, 10)}</span>
                <span>confidence {e.confidence.toFixed(2)}</span>
              </div>
              <blockquote>{e.excerpt}</blockquote>
            </div>
          ))
        )}
      </div>

      {/* --- candidate claims -------------------------------------------- */}
      <div className="panel">
        <h2>Approved claims cited · {packet.claims.length}</h2>
        {packet.claims.map((c) => (
          <div className="evidence" key={c.id}>
            <div className="meta">
              <span className="tag">{c.category}</span>
              <code>{c.key}</code>
              <span>{c.sourceRef ?? 'no source recorded'}</span>
            </div>
            <blockquote>{c.text}</blockquote>
          </div>
        ))}
      </div>

      {packet.brief && (
        <div className="panel">
          <h2>Research brief</h2>
          <p>{packet.brief.relevanceNote}</p>
          <p className="note">{packet.brief.citedEvidenceIds.length} citation(s)</p>
        </div>
      )}

      <div className="panel">
        <h2>History</h2>
        {packet.history.map((h, i) => (
          <div className="hist" key={i}>
            {h.at.slice(0, 19).replace('T', ' ')} · {h.actor} · {h.action}
            {h.reasonCode ? ` · ${h.reasonCode}` : ''}
          </div>
        ))}
      </div>
    </>
  )
}
