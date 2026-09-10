'use server'

import { revalidatePath } from 'next/cache'
import { db } from './lib/db.js'
import {
  acceptPacket,
  deferLead,
  markPacketSubmitted,
  recordPacketOutcome,
  rejectLead,
} from '../src/apply/packet/lifecycle.js'
import { queuePacketAnswers } from '../src/apply/packet/queue-answers.js'
import type { ReasonCodeValue } from '../src/core/reason-codes/registry.js'

/**
 * Part E's server actions — the dashboard's only write path.
 *
 * Every one of these delegates to `src/apply/packet/lifecycle.ts` rather than touching
 * a row itself. The UI is a view over the same functions the CLI and the tests drive,
 * so a decision made by clicking is the identical transition — same audit row, same
 * reason code — as one made from a script. A dashboard that wrote its own updates
 * would be a second implementation of the state machine, and the two would drift.
 *
 * **Nothing here submits an application** (H8). `submit` records that the operator
 * already applied through the employer's own form.
 */

export async function acceptPacketAction(packetId: string): Promise<void> {
  await acceptPacket(db, packetId, { actorId: 'operator' })
  revalidatePath('/')
  revalidatePath(`/packets/${packetId}`)
}

export async function deferLeadAction(packetId: string, note?: string): Promise<void> {
  await deferLead(db, packetId, { actorId: 'operator', ...(note ? { note } : {}) })
  revalidatePath('/')
  revalidatePath(`/packets/${packetId}`)
}

export async function rejectLeadAction(
  packetId: string,
  reason?: string,
  note?: string,
): Promise<void> {
  await rejectLead(db, packetId, {
    actorId: 'operator',
    ...(reason ? { reason: reason as ReasonCodeValue } : {}),
    ...(note ? { note } : {}),
  })
  revalidatePath('/')
  revalidatePath(`/packets/${packetId}`)
}

/**
 * Records a submission the operator already made by hand.
 *
 * The button is labelled "I applied", not "Apply" — the difference is the whole of
 * H8. This writes `application_submitted`, which is the state F4's Part C case-3
 * predicate reads to decide whether a follow-up is permitted at all.
 */
export async function markSubmittedAction(packetId: string, note?: string): Promise<void> {
  await markPacketSubmitted(db, packetId, {
    actorId: 'operator',
    ...(note ? { outcomeNote: note } : {}),
  })
  revalidatePath('/')
  revalidatePath(`/packets/${packetId}`)
}

export async function recordOutcomeAction(
  packetId: string,
  outcome: 'acknowledged' | 'interview' | 'rejected' | 'no_response',
  note?: string,
): Promise<void> {
  await recordPacketOutcome(db, packetId, outcome, { actorId: 'operator', ...(note ? { note } : {}) })
  revalidatePath('/')
  revalidatePath(`/packets/${packetId}`)
}

/** Queues the two judgment answers for a Claude Code session to fulfil later. */
export async function queueAnswersAction(packetId: string): Promise<void> {
  await queuePacketAnswers(db, packetId)
  revalidatePath(`/packets/${packetId}`)
}
