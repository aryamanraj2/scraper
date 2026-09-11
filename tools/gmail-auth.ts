#!/usr/bin/env tsx
/**
 * One-time Gmail OAuth consent, for an installed ("Desktop") app.
 *
 *   npm run gmail:auth              # print the consent URL
 *   npm run gmail:auth -- --code 4/0Ab...   # exchange the code for a refresh token
 *
 * ## Why there is no local web server
 *
 * Google withdrew the out-of-band flow in 2022, so an installed app must use a
 * loopback redirect. The textbook implementation runs an HTTP server on 127.0.0.1 to
 * catch it — and this project bans `node:http` everywhere outside
 * `src/core/policy/http/raw-client.ts`, enforced three ways (ESLint, the AST scanner,
 * and the backend tsconfig having no DOM lib). That ban is what makes
 * "`FetchPolicyGate` is the only path to the network" a structural claim rather than a
 * convention, and it is not worth spending for a flow the operator runs once.
 *
 * It is not needed. The browser lands on `http://127.0.0.1:<port>/?code=...`, fails to
 * connect, and leaves the code in the address bar. Copy it, paste it here. The code is
 * single-use and expires in minutes.
 *
 * A Desktop client accepts any loopback port without pre-registering a redirect URI,
 * which is why this works with the client the operator already created.
 *
 * ## What is stored
 *
 * The refresh token, envelope-encrypted through `SecretStore` (A5): sealed under a
 * data key, the data key sealed under the macOS Keychain KEK, ciphertext in
 * `secret_record`, and the plaintext registered with the redactor so it is masked at
 * every log sink. It is never written to `.env` and never printed.
 *
 * **This is a live command.** It talks to Google's token endpoint — through
 * `FetchPolicyGate`, like everything else.
 */
import 'dotenv/config'
import { prisma, disconnectPrisma } from '../src/core/db/client.js'
import { env } from '../src/core/config/config.js'
import { FetchPolicyGate } from '../src/core/policy/fetch-policy-gate.js'
import { SecretStore } from '../src/core/crypto/secret-store.js'
import { KeychainKeyProvider } from '../src/core/crypto/keychain-key-provider.js'
import { EnvKeyProvider } from '../src/core/crypto/env-key-provider.js'
import {
  buildConsentUrl,
  exchangeConsentCode,
  GMAIL_SCOPE,
  GmailTokenProvider,
  REFRESH_TOKEN_SECRET,
} from '../src/outreach/mail/oauth.js'

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

/** Any loopback port: a Desktop client does not pre-register one. */
const REDIRECT_URI = 'http://127.0.0.1:53682'

const config = env()
const clientId = config.GMAIL_OAUTH_CLIENT_ID
const clientSecret = config.GMAIL_OAUTH_CLIENT_SECRET
if (!clientId || !clientSecret) {
  console.error('GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET must be set in .env.')
  process.exit(1)
}

const db = prisma()
const gate = new FetchPolicyGate(db, {
  userAgent: config.USER_AGENT,
  robotsTtlSeconds: config.ROBOTS_CACHE_TTL_SECONDS,
  defaultRateDelayMs: config.DEFAULT_HOST_RATE_DELAY_MS,
})
const keyProvider =
  config.KEY_PROVIDER === 'env'
    ? new EnvKeyProvider(config.OUTREACH_KEK_BASE64 ?? '')
    : new KeychainKeyProvider(config.KEYCHAIN_SERVICE, config.KEYCHAIN_ACCOUNT)
const secrets = new SecretStore(db, keyProvider)

// Checked before the URL is even printed, so a missing KEK is found before the
// operator walks through a browser consent rather than after the code is spent.
try {
  await secrets.assertWritable()
} catch (err) {
  console.error(`\nCannot store a refresh token: ${(err as Error).message}\n`)
  console.error('Fix that first — the consent code is single-use and expires in minutes.')
  await disconnectPrisma()
  process.exit(1)
}

const code = flag('code')

if (flag('check') !== undefined || process.argv.includes('--check')) {
  const tokens = new GmailTokenProvider(gate, secrets, { clientId, clientSecret })
  try {
    await tokens.accessToken()
    console.log('✓ refresh token present and a fresh access token was obtained.')
  } catch (err) {
    console.error(`✗ ${(err as Error).message}`)
    process.exitCode = 1
  }
} else if (!code) {
  console.log('\n1. Open this URL and grant access:\n')
  console.log(
    buildConsentUrl({ clientId, redirectUri: REDIRECT_URI, loginHint: config.GMAIL_SENDING_ACCOUNT }),
  )
  console.log(`\n   Scope requested: ${GMAIL_SCOPE}`)
  console.log('   (gmail.modify — send, plus the rfc822msgid: reconciliation search, plus reply reads.')
  console.log('    Not https://mail.google.com/, which would include permanent delete.)')
  console.log('\n2. The browser will land on 127.0.0.1 and fail to connect. That is expected —')
  console.log('   there is no local server by design. Copy the `code=` value from the address bar.')
  console.log('\n3. Run:  npm run gmail:auth -- --code <the code>\n')
} else {
  const result = await exchangeConsentCode(gate, secrets, {
    clientId,
    clientSecret,
    code,
    redirectUri: REDIRECT_URI,
  })
  console.log(`\n✓ refresh token stored under "${REFRESH_TOKEN_SECRET}" (envelope-encrypted).`)
  console.log(`  granted scope: ${result.scope ?? '(not reported)'}`)
  if (result.scope && !result.scope.includes('gmail.modify')) {
    console.log('\n  ⚠ The granted scope does not include gmail.modify. A send would work and the')
    console.log('    rfc822msgid: reconciliation would not — which is the half that stops a double')
    console.log('    send. Re-run the consent and leave every box ticked.')
  }
  console.log('')
}

await disconnectPrisma()
