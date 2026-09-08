import { MockAgent, setGlobalDispatcher } from 'undici'
import { beforeAll, afterAll } from 'vitest'
import { config as loadDotenv } from 'dotenv'

loadDotenv({ quiet: true })
process.env.NODE_ENV = 'test'
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL

/**
 * handover.md §11: never run uncontrolled live-source tests.
 *
 * The mock agent is installed as undici's global dispatcher with net connect
 * disabled, so any real outbound request throws rather than silently succeeding.
 * src/core/policy/http/raw-client.ts calls undici's `request` explicitly (not the
 * global `fetch`, which may be backed by a different undici instance), so this
 * dispatcher sits in the real request path.
 *
 * That is what makes Part G's "assert zero HTTP requests to the host, at transport
 * layer not adapter" a genuine assertion: a bug that bypassed the gate would open a
 * socket, and opening a socket fails the test.
 */
export const mockAgent = new MockAgent()

beforeAll(() => {
  mockAgent.disableNetConnect()
  setGlobalDispatcher(mockAgent)
})

afterAll(async () => {
  await mockAgent.close()
})
