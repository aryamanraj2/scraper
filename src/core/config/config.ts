import { z } from 'zod'
import { MILESTONE_STAGE, stageAllowsSending, type Milestone } from './stage.js'

const boolish = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1')

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  TEST_DATABASE_URL: z.string().min(1).optional(),

  KEY_PROVIDER: z.enum(['keychain', 'env']).default('keychain'),
  KEYCHAIN_SERVICE: z.string().default('outreach-intelligence'),
  KEYCHAIN_ACCOUNT: z.string().default('kek'),
  OUTREACH_KEK_BASE64: z.string().optional(),

  SUPPRESSION_HMAC_SALT: z.string().min(1),

  SENDING_ENABLED: boolish.default(false),

  /**
   * The addresses this build is permitted to send to while the recipient policy is
   * `owned_only` — see `src/outreach/send/recipient-policy.ts`.
   *
   * Comma-separated. An untagged entry admits its own `+tag` variants, so
   * `aryamanj250@gmail.com` covers `+f5a`, `+f5b` and `+f5c` without listing each.
   * Empty (the default) refuses every recipient, which is the correct behaviour for
   * a build that has not been told what it owns.
   */
  OWNED_INBOXES: z
    .string()
    .default('')
    .transform((v) => v.split(',').map((s) => s.trim()).filter((s) => s !== '')),

  /**
   * Lifts the owned-inbox restriction — F6's pilot switch, present now so that
   * lifting it is an explicit act rather than a side effect of the stage bump.
   *
   * It does nothing below F6. `resolveRecipientPolicy` requires the stage AND the
   * flag, the same two-factor shape `resolveSendingEnabled` uses one level up.
   */
  SEND_EXTERNAL_RECIPIENTS_ENABLED: boolish.default(false),

  /**
   * The mailbox the Gmail adapter authenticates as and sends from.
   *
   * Configuration, not an assumption: the pilot sends from a personal Gmail (already
   * DKIM-signed by Google and warmed by years of real history, where a fresh domain
   * spends three weeks earning the same trust), and migrates to a Workspace mailbox
   * on the owned domain around F6. Nothing downstream may hardcode either.
   */
  GMAIL_SENDING_ACCOUNT: z.string().min(1).optional(),
  GMAIL_OAUTH_CLIENT_ID: z.string().optional(),
  GMAIL_OAUTH_CLIENT_SECRET: z.string().optional(),

  /**
   * The domain part of the deterministic RFC 5322 `Message-ID` (A9).
   *
   * The owned domain rather than the sending account's, deliberately: A9 requires a
   * "stable domain part on the owned sending domain", and this value has to survive
   * the migration off gmail.com unchanged or every historical Message-ID stops being
   * reconstructible from its `SendAttempt`.
   */
  MESSAGE_ID_DOMAIN: z.string().min(1).default('aryamanj.in'),

  /**
   * D4 tier 3. Absent means escalation is disabled: B6a's credits were unclaimed
   * at F2, and H9's rule for optional capability applies — the pipeline must be
   * correct with it missing, never broken by its absence.
   */
  FIRECRAWL_API_KEY: z.string().optional(),

  /**
   * Blind pattern construction — building `first.last@domain` from a name and a
   * domain nobody published together.
   *
   * OFF by default and operator-flippable, per the F4 scope note. `handover.md` §1.2
   * still forbids it as a *targeting* method, and this flag does not amend that: a
   * pattern-inferred `Contact` is written with `verified = false`, and an unverified
   * contact opens **no** outreach case (`src/core/policy/outreach-case.ts`). What the
   * flag buys is a candidate row the operator can confirm by hand, plus a per-row
   * `discoveryMethod` so bounce analysis can separate the methods instead of
   * averaging them — which is the only honest way to find out whether inference is
   * worth anything.
   *
   * Turning it on cannot, by itself, cause a message to be sent to a constructed
   * address. That is the property that makes it safe to expose at all.
   */
  CONTACT_ALLOW_PATTERN_INFERENCE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  USER_AGENT: z.string().min(1),
  ROBOTS_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),
  DEFAULT_HOST_RATE_DELAY_MS: z.coerce.number().int().nonnegative().default(5_000),

  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
})

export type Env = z.infer<typeof EnvSchema>

let cached: Env | undefined

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source)
  if (!parsed.success) {
    // z.prettifyError avoids echoing the offending VALUES, which may be secrets.
    throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`)
  }
  return parsed.data
}

export function env(): Env {
  cached ??= loadEnv()
  return cached
}

/** Test seam only. */
export function resetEnvCache(): void {
  cached = undefined
}

export type SendingDecision =
  | { enabled: true }
  | { enabled: false; reason: 'sending_disabled' }

/**
 * D6 condition 9, plus the Part F build-stage guard.
 *
 * Three independent things must all hold before a byte leaves the mailbox:
 *   1. the build has reached the sending milestone (source-level, reviewed),
 *   2. the operator set the env flag, and
 *   3. no kill switch is engaged (checked separately, inside the send gate's
 *      transaction, because it can change between here and the provider call).
 *
 * This function covers 1 and 2. It returns `sending_disabled` rather than
 * throwing, so callers record a reason code like every other refusal.
 */
export function resolveSendingEnabled(
  opts: { envFlag?: boolean; stage?: Milestone } = {},
): SendingDecision {
  const stage = opts.stage ?? MILESTONE_STAGE
  const envFlag = opts.envFlag ?? env().SENDING_ENABLED
  if (!stageAllowsSending(stage)) return { enabled: false, reason: 'sending_disabled' }
  if (!envFlag) return { enabled: false, reason: 'sending_disabled' }
  return { enabled: true }
}
