import type { Prisma, PrismaClient } from '../../../generated/prisma/client.js'
import type { AuditActorType } from '../../../generated/prisma/enums.js'
import { redact } from '../logging/redact.js'
import type { ReasonCodeValue } from '../reason-codes/registry.js'

export type AuditEntry = {
  actorType: AuditActorType
  actorId: string
  action: string
  subjectType: string
  subjectId?: string | undefined
  reasonCode?: ReasonCodeValue | undefined
  costUsd?: number | undefined
  metadata?: Record<string, unknown> | undefined
}

/** Anything that can run a Prisma write: the client, or an interactive transaction. */
export type Db = PrismaClient | Prisma.TransactionClient

/**
 * Append-only audit writer.
 *
 * handover.md §11's acceptance standard is that every message can be reconstructed
 * from source evidence, score reason, recipient policy decision, resume, draft
 * version, approval event and delivery outcome. That is only true if a row exists
 * for every transition — so this module deliberately exposes no update and no
 * delete, and metadata is redacted before it is written rather than after.
 */
export async function writeAudit(db: Db, entry: AuditEntry): Promise<void> {
  await db.auditLog.create({
    data: {
      actorType: entry.actorType,
      actorId: entry.actorId,
      action: entry.action,
      subjectType: entry.subjectType,
      subjectId: entry.subjectId ?? null,
      reasonCode: entry.reasonCode ?? null,
      costUsd: entry.costUsd ?? null,
      ...(entry.metadata === undefined
        ? {}
        : { metadata: redact(entry.metadata) as Prisma.InputJsonValue }),
    },
  })
}

/**
 * Preflight-refusal counters, by reason (Part G observability). A source silently
 * disappearing behind a robots or terms change must be visible rather than
 * mistaken for absent data.
 */
export async function countRefusalsByReason(
  db: Db,
  since: Date,
): Promise<Record<string, number>> {
  const rows = await db.auditLog.groupBy({
    by: ['reasonCode'],
    where: { createdAt: { gte: since }, reasonCode: { not: null } },
    _count: { _all: true },
  })
  const out: Record<string, number> = {}
  for (const row of rows) {
    if (row.reasonCode) out[row.reasonCode] = row._count._all
  }
  return out
}
