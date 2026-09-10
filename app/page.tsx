import { db } from './lib/db.js'
import { listPackets, queueCounts } from '../src/apply/viewer/queues.js'

export const dynamic = 'force-dynamic'

/**
 * The review queue — `handover.md` §9, and the ten-minute daily review of §15.
 *
 * Ordered by score descending so the review starts where the evidence is strongest.
 * Queues a later milestone fills are rendered as "not built", never as `0`: a zero
 * beside "Bounced" reads as "nothing has bounced", which is the empty-chart-implies-
 * health failure B3 warns about.
 */
export default async function QueuesPage() {
  const [counts, packets] = await Promise.all([queueCounts(db), listPackets(db)])
  const unanswered = packets.reduce((a, p) => a + p.unanswered, 0)

  return (
    <>
      <div className="queues">
        {counts.map((q) => (
          <div key={q.key} className={q.available ? 'queue' : 'queue unavailable'} title={q.description}>
            <div className="n">{q.available ? q.count : `not built · ${q.milestone}`}</div>
            <div className="l">{q.label}</div>
          </div>
        ))}
      </div>

      <div className="h8">
        <strong>H8 — the system prepares, you submit.</strong> Every packet links to the
        employer&rsquo;s own application form. Nothing here posts to an ATS, and no code path can.
      </div>

      {unanswered > 0 && (
        <div className="warnbox">
          {unanswered} question{unanswered === 1 ? '' : 's'} across these packets{' '}
          {unanswered === 1 ? 'is' : 'are'} deliberately blank — either no approved claim covers it
          (expected graduation, availability) or it needs a judgment answer still queued for a
          Claude Code session. Fill those in yourself at submit time; nothing was invented.
        </div>
      )}

      <div className="panel">
        <h2>Application packets · {packets.length}</h2>
        {packets.length === 0 ? (
          <p className="note">
            None yet. Run <code>npm run seed:operator</code> then <code>npm run packets:run</code>.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th className="num">Score</th>
                <th>Company</th>
                <th>Role</th>
                <th>Track / resume</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {packets.map((p) => (
                <tr key={p.packetId}>
                  <td className="num">{p.score ?? '—'}</td>
                  <td>
                    <a href={`/packets/${p.packetId}`}>{p.companyName}</a>
                    <div className="note">{p.countries.join(', ') || 'country unmapped'}</div>
                  </td>
                  <td>
                    {p.roleTitle ?? <span className="note">(untitled posting)</span>}
                    {p.unanswered > 0 && (
                      <>
                        {' '}
                        <span className="tag warn">{p.unanswered} blank</span>
                      </>
                    )}
                  </td>
                  <td>
                    <span className="tag">{p.trackKey ?? 'no track'}</span>
                    <div className="note">{p.resumeLabel}</div>
                  </td>
                  <td>
                    <span className={p.status === 'submitted' ? 'tag good' : 'tag'}>{p.status}</span>
                    {p.leadStatus && p.leadStatus !== 'qualified' && (
                      <>
                        {' '}
                        <span className="tag">{p.leadStatus}</span>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}
