import tseslint from 'typescript-eslint'

/**
 * Defence in depth for the F0 network invariant. The authoritative check is
 * tools/check-no-raw-http.ts, which walks the AST and runs as part of `npm test` —
 * this config catches the same mistakes in the editor, earlier.
 */
const NETWORK_MODULES = [
  'undici', 'axios', 'got', 'node-fetch', 'superagent', 'request',
  'node:http', 'node:https', 'http', 'https', 'node:http2', 'http2',
]

export default tseslint.config(
  { ignores: ['generated/**', 'node_modules/**', 'prisma/migrations/**', '.next/**'] },
  ...tseslint.configs.recommended,
  {
    // .tsx included from F3: the dashboard's tsconfig has `lib: DOM`, so `fetch` is a
    // typed global in app/ and the type layer no longer catches it there. The lint and
    // AST layers must.
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: NETWORK_MODULES.map((name) => ({
          name,
          message: 'Network access must go through FetchPolicyGate. Only src/core/policy/http/raw-client.ts may import an HTTP client.',
        })),
        patterns: [{
          group: ['**/policy/http/raw-client*'],
          message: 'Adapters receive a FetchPolicyGate, never a client.',
        }],
      }],
      'no-restricted-globals': ['error',
        { name: 'fetch', message: 'Use FetchPolicyGate.fetchText — the preflight is not optional.' },
        { name: 'XMLHttpRequest', message: 'Use FetchPolicyGate.fetchText.' },
        { name: 'WebSocket', message: 'Use FetchPolicyGate.fetchText.' },
      ],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // The gate's own client, and the test harness that proves no socket opens.
    files: ['src/core/policy/http/raw-client.ts', 'test/setup.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
)
