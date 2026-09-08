import type { Db } from '../audit/audit-log.js'
import { writeAudit } from '../audit/audit-log.js'
import type { KillSwitchScope } from '../../../generated/prisma/enums.js'
import type { ReasonCodeValue } from '../reason-codes/registry.js'

export const GLOBAL_TARGET = '*'

export type KillSwitchQuery = {
  /** Recipient domain, for scope=domain. */
  domain?: string | undefined
  /** Sender identity, for scope=account. */
  account?: string | undefined
}

export type KillSwitchDecision =
  | { engaged: false }
  | { engaged: true; scope: KillSwitchScope; target: string; reason: ReasonCodeValue }

const REASON_BY_SCOPE: Record<KillSwitchScope, ReasonCodeValue> = {
  global: 'kill_switch_global',
  domain: 'kill_switch_domain',
  account: 'kill_switch_account',
}

/**
 * A12: the kill switch needs global / per-domain / per-account scope, and engaging
 * it must CANCEL scheduled jobs rather than pause them — a paused job resumes on
 * restart and sends the mail the operator stopped.
 *
 * Cancellation lives in src/core/queue/boss.ts (`cancelScheduledSends`) because it
 * is a queue operation; this module owns the state and the decision. F5 proves the
 * cancellation end to end.
 */
export async function checkKillSwitch(
  db: Db,
  query: KillSwitchQuery = {},
): Promise<KillSwitchDecision> {
  const targets: Array<{ scope: KillSwitchScope; target: string }> = [
    { scope: 'global', target: GLOBAL_TARGET },
  ]
  if (query.domain) targets.push({ scope: 'domain', target: query.domain.toLowerCase() })
  if (query.account) targets.push({ scope: 'account', target: query.account.toLowerCase() })

  const rows = await db.killSwitch.findMany({
    where: { engaged: true, OR: targets.map((t) => ({ scope: t.scope, target: t.target })) },
  })

  // Global first: the broadest engaged switch is the honest reason to report.
  for (const scope of ['global', 'domain', 'account'] as const) {
    const hit = rows.find((r) => r.scope === scope)
    if (hit) {
      return { engaged: true, scope, target: hit.target, reason: REASON_BY_SCOPE[scope] }
    }
  }
  return { engaged: false }
}

export async function engageKillSwitch(
  db: Db,
  scope: KillSwitchScope,
  target: string,
  actorId: string,
  note?: string,
): Promise<void> {
  const normalized = scope === 'global' ? GLOBAL_TARGET : target.toLowerCase()
  const reasonCode = REASON_BY_SCOPE[scope]
  await db.killSwitch.upsert({
    where: { scope_target: { scope, target: normalized } },
    create: {
      scope,
      target: normalized,
      engaged: true,
      reasonCode,
      note: note ?? null,
      actorId,
      engagedAt: new Date(),
    },
    update: { engaged: true, reasonCode, note: note ?? null, actorId, engagedAt: new Date(), releasedAt: null },
  })
  await writeAudit(db, {
    actorType: 'user',
    actorId,
    action: 'kill_switch.engage',
    subjectType: 'KillSwitch',
    subjectId: `${scope}:${normalized}`,
    reasonCode,
    metadata: { note },
  })
}

export async function releaseKillSwitch(
  db: Db,
  scope: KillSwitchScope,
  target: string,
  actorId: string,
): Promise<void> {
  const normalized = scope === 'global' ? GLOBAL_TARGET : target.toLowerCase()
  await db.killSwitch.updateMany({
    where: { scope, target: normalized },
    data: { engaged: false, releasedAt: new Date(), actorId },
  })
  await writeAudit(db, {
    actorType: 'user',
    actorId,
    action: 'kill_switch.release',
    subjectType: 'KillSwitch',
    subjectId: `${scope}:${normalized}`,
  })
}
