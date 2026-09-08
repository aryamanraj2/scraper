import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * F0 exit criterion: "no HTTP client is reachable outside the gate."
 *
 * The scanner runs as its own npm script too, but wiring it into the suite means a
 * violation fails `npm test` rather than only a step someone can skip. The negative
 * case below matters as much as the positive one: a guard that never fails is
 * indistinguishable from a guard that does not work.
 */
function runScanner(cwd: string): { ok: boolean; output: string } {
  try {
    const tsx = join(process.cwd(), 'node_modules', '.bin', 'tsx')
    const out = execFileSync(tsx, [join(process.cwd(), 'tools/check-no-raw-http.ts')], {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
    })
    return { ok: true, output: out }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string }
    return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

describe('no raw HTTP client outside the gate', () => {
  it('the real source tree is clean', () => {
    const result = runScanner(process.cwd())
    expect(result.output).toContain('clean')
    expect(result.ok).toBe(true)
  })

  it('catches a direct undici import in an adapter', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rawhttp-'))
    try {
      mkdirSync(join(dir, 'src', 'adapters'), { recursive: true })
      writeFileSync(
        join(dir, 'src', 'adapters', 'sneaky.ts'),
        "import { request } from 'undici'\nexport const go = () => request('https://example.com')\n",
      )
      const result = runScanner(dir)
      expect(result.ok).toBe(false)
      expect(result.output).toContain('imports "undici"')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('catches a bare fetch call', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rawhttp-'))
    try {
      mkdirSync(join(dir, 'src'), { recursive: true })
      writeFileSync(join(dir, 'src', 'sneaky.ts'), "export const go = () => fetch('https://example.com')\n")
      const result = runScanner(dir)
      expect(result.ok).toBe(false)
      expect(result.output).toContain('references the "fetch" global')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('catches an adapter reaching around the gate into the raw client', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rawhttp-'))
    try {
      mkdirSync(join(dir, 'src', 'adapters'), { recursive: true })
      writeFileSync(
        join(dir, 'src', 'adapters', 'sneaky.ts'),
        "import { rawGet } from '../core/policy/http/raw-client.js'\nexport const go = () => rawGet('https://example.com', { userAgent: 'x' })\n",
      )
      const result = runScanner(dir)
      expect(result.ok).toBe(false)
      expect(result.output).toContain('use FetchPolicyGate')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('catches a dynamic import used to dodge the static import ban', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rawhttp-'))
    try {
      mkdirSync(join(dir, 'src'), { recursive: true })
      writeFileSync(join(dir, 'src', 'sneaky.ts'), "export const go = async () => (await import('node:https'))\n")
      const result = runScanner(dir)
      expect(result.ok).toBe(false)
      expect(result.output).toContain('dynamically loads "node:https"')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
