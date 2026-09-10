#!/usr/bin/env tsx
/**
 * F0 exit criterion: "no HTTP client is reachable outside the gate."
 *
 * ESLint already bans these imports, but a lint config is one `// eslint-disable`
 * or one careless refactor away from silence. This walks the TypeScript AST
 * directly and fails `npm test`, so the invariant survives changes to the lint
 * setup rather than depending on it.
 *
 * Detects, outside the single permitted file:
 *   - imports of undici, axios, got, node-fetch, superagent, node:http(s)
 *   - require() of the same
 *   - references to the bare `fetch`, `XMLHttpRequest` or `WebSocket` globals
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from 'typescript'

const ROOT = process.cwd()
// app/ is in scope from F3. The dashboard talks to Postgres through Prisma and
// issues no HTTP of its own, and its tsconfig deliberately has `lib: DOM` — which
// makes `fetch` a typed global there. That removes one of the three layers for UI
// code specifically, so this scanner has to cover it.
const SCAN_DIRS = ['src', 'test', 'tools', 'app']

/** The one file allowed to reach the network. See its header for why. */
const PERMITTED = new Set([join('src', 'core', 'policy', 'http', 'raw-client.ts')])

/**
 * The test harness installs undici's MockAgent to prove that no socket is opened
 * to a denied host. That setup necessarily imports undici, and it is the assertion
 * mechanism rather than an escape from it.
 */
const PERMITTED_TEST_HARNESS = new Set([join('test', 'setup.ts')])

const BANNED_MODULES = new Set([
  'undici', 'axios', 'got', 'node-fetch', 'superagent', 'request',
  'node:http', 'node:https', 'http', 'https', 'node:http2', 'http2',
])
const BANNED_GLOBALS = new Set(['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'])

type Finding = { file: string; line: number; detail: string }

function* walk(dir: string): Generator<string> {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'generated' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if ((full.endsWith('.ts') || full.endsWith('.tsx')) && !full.endsWith('.d.ts')) yield full
  }
}

function scan(file: string): Finding[] {
  const rel = relative(ROOT, file)
  if (PERMITTED.has(rel) || PERMITTED_TEST_HARNESS.has(rel)) return []

  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.ES2023,
    true,
  )
  const findings: Finding[] = []
  const at = (node: ts.Node) =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text
      if (BANNED_MODULES.has(spec)) {
        findings.push({ file: rel, line: at(node), detail: `imports "${spec}"` })
      }
      // Reaching into the raw client from elsewhere defeats the point.
      if (spec.includes('policy/http/raw-client')) {
        findings.push({ file: rel, line: at(node), detail: 'imports the raw HTTP client directly; use FetchPolicyGate' })
      }
    }

    if (
      ts.isCallExpression(node) &&
      (node.expression.getText(source) === 'require' ||
        node.expression.kind === ts.SyntaxKind.ImportKeyword)
    ) {
      const arg = node.arguments[0]
      if (arg && ts.isStringLiteral(arg)) {
        if (BANNED_MODULES.has(arg.text)) {
          findings.push({ file: rel, line: at(node), detail: `dynamically loads "${arg.text}"` })
        }
        if (arg.text.includes('policy/http/raw-client')) {
          findings.push({ file: rel, line: at(node), detail: 'dynamically loads the raw HTTP client' })
        }
      }
    }

    if (ts.isIdentifier(node) && BANNED_GLOBALS.has(node.text)) {
      const parent = node.parent
      // Property accesses (obj.fetch) and declarations of our own names are fine;
      // only a bare reference to the global is a finding.
      const isPropertyAccess = ts.isPropertyAccessExpression(parent) && parent.name === node
      const isDeclarationName =
        (ts.isPropertySignature(parent) || ts.isPropertyAssignment(parent) ||
          ts.isMethodDeclaration(parent) || ts.isMethodSignature(parent) ||
          ts.isVariableDeclaration(parent) || ts.isBindingElement(parent) ||
          ts.isParameter(parent)) && (parent as { name?: ts.Node }).name === node
      if (!isPropertyAccess && !isDeclarationName) {
        findings.push({ file: rel, line: at(node), detail: `references the "${node.text}" global` })
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(source)
  return findings
}

const findings: Finding[] = []
for (const dir of SCAN_DIRS) {
  for (const file of walk(join(ROOT, dir))) findings.push(...scan(file))
}

if (findings.length > 0) {
  console.error('Network access outside the FetchPolicyGate:\n')
  for (const f of findings) {
    console.error(`  ${f.file.split(sep).join('/')}:${f.line}  ${f.detail}`)
  }
  console.error(
    '\nAdapters must receive a FetchPolicyGate, never a client. The only file that may' +
      '\nreach the network is src/core/policy/http/raw-client.ts.\n',
  )
  process.exit(1)
}

console.log(
  `check-no-raw-http: clean — no network access outside ${[...PERMITTED].join(', ')}`,
)
