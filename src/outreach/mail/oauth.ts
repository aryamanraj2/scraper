import { z } from 'zod'
import type { FetchPolicyGate } from '../../core/policy/fetch-policy-gate.js'
import type { SecretStore } from '../../core/crypto/secret-store.js'

/**
 * Google OAuth 2.0 for an installed ("Desktop") app — A5, applied to the mailbox.
 *
 * ## Where the refresh token lives
 *
 * A5's rule as the plan restates it: *"no plaintext credential in the database, and no
 * credential may ever enter an LLM prompt or a log line."* The original handover said
 * never to store an OAuth refresh token in the database at all, and A5 records why
 * that is unimplementable — a worker has to send a scheduled follow-up days later,
 * unattended.
 *
 * So the refresh token is enveloped by `SecretStore`: encrypted under a data key,
 * the data key encrypted under a KEK in the macOS Keychain, ciphertext in Postgres.
 * `SecretStore.put` also registers the value with the redactor, so if it ever surfaces
 * in an error, a stack trace or an audit blob it is masked at the sink.
 *
 * The **access** token is never persisted at all. It lives for an hour and is held in
 * memory for the life of the process; writing it down would be a second copy of a
 * credential for no benefit.
 *
 * ## Why the loopback flow has no loopback server
 *
 * Google requires the loopback redirect for installed apps (the out-of-band `oob`
 * flow was withdrawn in 2022). The usual implementation runs a local HTTP server to
 * catch the redirect — and this project bans `node:http` everywhere outside
 * `raw-client.ts`, enforced by ESLint, an AST scanner and the absence of a DOM lib.
 *
 * It does not need one. The browser lands on `http://127.0.0.1:<port>/?code=...`,
 * fails to connect, and leaves the code sitting in the address bar where the operator
 * can copy it. One paste replaces a server, and the ban stays intact. `tools/gmail-auth.ts`
 * is the flow.
 */

export const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

/**
 * A9 and Part E: `gmail.modify` is the minimum that supports all three things the
 * milestone needs.
 *
 * - `gmail.send` alone cannot run the `rfc822msgid:` reconciliation search, which is
 *   what makes A9 step 2 possible and therefore what stops the double send.
 * - `gmail.metadata` cannot read message bodies, which reply classification needs.
 * - `https://mail.google.com/` is full access including permanent delete. Asking for
 *   it would be asking for more than the job requires from a mailbox that is also the
 *   operator's personal email.
 */
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify'

/** The `SecretRecord.name` the refresh token is stored under. */
export const REFRESH_TOKEN_SECRET = 'gmail.oauth.refresh_token'

const TokenResponse = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  token_type: z.string(),
  scope: z.string().optional(),
  refresh_token: z.string().min(1).optional(),
})

export type OAuthConfig = {
  clientId: string
  clientSecret: string
}

export type AccessToken = { token: string; expiresAt: Date }

export class GmailAuthError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message)
    this.name = 'GmailAuthError'
  }
}

/** The consent URL the operator opens in a browser. */
export function buildConsentUrl(opts: {
  clientId: string
  redirectUri: string
  loginHint?: string | undefined
}): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: 'code',
    scope: GMAIL_SCOPE,
    // Both are required to be issued a refresh token at all: `offline` asks for one,
    // and `consent` forces the prompt even when the user has approved before — without
    // it a re-authorisation silently returns an access token and no refresh token, and
    // the failure surfaces days later when the first one expires.
    access_type: 'offline',
    prompt: 'consent',
    ...(opts.loginHint ? { login_hint: opts.loginHint } : {}),
  })
  return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`
}

async function postToken(
  gate: FetchPolicyGate,
  form: Record<string, string>,
): Promise<z.infer<typeof TokenResponse>> {
  const result = await gate.postForm(GOOGLE_TOKEN_ENDPOINT, form, {
    // Not research. A research cap must never be able to refuse a token refresh and
    // thereby abort an approved send with `budget_exhausted` (F5 §4.3).
    companyId: null,
    cost: 0,
  })
  if (!result.ok) {
    throw new GmailAuthError(`token endpoint refused by FetchPolicyGate: ${result.reason}`)
  }
  if (result.response.statusCode !== 200) {
    // The body of a failed token response carries `error` and `error_description` and
    // no credential, so quoting it is safe and is the only way to tell
    // `invalid_grant` (token revoked — re-authorise) from a transient 5xx.
    throw new GmailAuthError(
      `token endpoint returned ${result.response.statusCode}`,
      result.response.body.slice(0, 400),
    )
  }
  const parsed = TokenResponse.safeParse(JSON.parse(result.response.body))
  if (!parsed.success) throw new GmailAuthError('token response did not match the expected shape')
  return parsed.data
}

/**
 * Exchanges a one-time consent code for a refresh token and stores it enveloped.
 *
 * Returns the granted scope so the caller can show the operator what they actually
 * authorised — a consent screen where a box was unticked yields a token that fails at
 * the first send, days later, with a 403 that names nothing.
 */
export async function exchangeConsentCode(
  gate: FetchPolicyGate,
  secrets: SecretStore,
  opts: OAuthConfig & { code: string; redirectUri: string },
): Promise<{ scope: string | undefined; storedRefreshToken: boolean }> {
  // **Prove we can store the token BEFORE spending the code.**
  //
  // A consent code is single-use and expires in minutes. The first version of this
  // exchanged it and then called `secrets.put`, which is the natural order and is
  // wrong: on a machine where the Keychain KEK had never been provisioned, the
  // exchange succeeded, Google issued a refresh token, the store threw — and the code
  // was burned, so the operator had to walk through the browser consent again to
  // recover from a misconfiguration that was knowable a second earlier.
  //
  // The general shape: when a step consumes a single-use external resource, every
  // precondition that can be checked locally must be checked first.
  await secrets.assertWritable()

  const tokens = await postToken(gate, {
    code: opts.code,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    redirect_uri: opts.redirectUri,
    grant_type: 'authorization_code',
  })

  if (!tokens.refresh_token) {
    throw new GmailAuthError(
      'Google returned no refresh_token. That happens when the consent was already ' +
        'granted and `prompt=consent` was not sent, or when the code was reused. ' +
        'Re-run the flow with a fresh code.',
    )
  }
  await secrets.put(REFRESH_TOKEN_SECRET, tokens.refresh_token, 'operator')
  return { scope: tokens.scope, storedRefreshToken: true }
}

/**
 * Holds an access token in memory and refreshes it when it is close to expiring.
 *
 * Refreshing sixty seconds early is not superstition: a token that passes the check
 * and expires in transit produces a 401 on a `messages.send` whose outcome is then
 * genuinely ambiguous, which is the exact state A9's reconciliation exists to clean up
 * after. Avoiding the ambiguity is cheaper than resolving it.
 */
export class GmailTokenProvider {
  private cached: AccessToken | null = null

  constructor(
    private readonly gate: FetchPolicyGate,
    private readonly secrets: SecretStore,
    private readonly config: OAuthConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async accessToken(): Promise<string> {
    const now = this.now()
    if (this.cached && this.cached.expiresAt.getTime() - 60_000 > now.getTime()) {
      return this.cached.token
    }

    const refreshToken = await this.secrets.get(REFRESH_TOKEN_SECRET, 'mail-adapter')
    if (!refreshToken) {
      throw new GmailAuthError(
        `no refresh token stored under "${REFRESH_TOKEN_SECRET}". Run \`npm run gmail:auth\`.`,
      )
    }

    const tokens = await postToken(this.gate, {
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    })

    // Google may rotate the refresh token. Storing the new one when it arrives is the
    // difference between a mailbox that keeps working and one that stops in a week.
    if (tokens.refresh_token && tokens.refresh_token !== refreshToken) {
      await this.secrets.put(REFRESH_TOKEN_SECRET, tokens.refresh_token, 'mail-adapter')
    }

    this.cached = {
      token: tokens.access_token,
      expiresAt: new Date(now.getTime() + tokens.expires_in * 1000),
    }
    return this.cached.token
  }

  /** Test seam, and the correct response to a 401 mid-run. */
  invalidate(): void {
    this.cached = null
  }
}
