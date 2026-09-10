import 'server-only'
import { prisma } from '../../src/core/db/client.js'

/**
 * The dashboard's only data source.
 *
 * `server-only` makes importing this from a client component a build error. That is
 * the seam that keeps the invariant true: the UI reaches Postgres through Prisma on
 * the server and issues no HTTP of its own, so nothing in `app/` ever needs to be
 * near `FetchPolicyGate` — or around it.
 */
export const db = prisma()
