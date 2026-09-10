/**
 * Next config for the F3 dashboard.
 *
 * ## Why `extensionAlias`, and why the webpack bundler
 *
 * The backend is `module: NodeNext`, so every import in `src/` carries an explicit
 * `.js` extension — `import { x } from './y.js'` resolving to `y.ts`. That is
 * mandatory under NodeNext and it is how F0-F2 were written.
 *
 * A bundler resolving with `moduleResolution: bundler` takes `./y.js` literally and
 * fails. `resolve.extensionAlias` maps the specifier back onto the TypeScript source,
 * which is the standard fix and keeps the backend's module style untouched — the
 * alternative was rewriting several hundred imports across `src/` to suit the UI,
 * which would be the tail wagging the dog on a milestone that must keep 300+ tests
 * green.
 *
 * `--webpack` is set on `dev` and `build` because `extensionAlias` is a webpack
 * resolver feature. Turbopack is Next 16's default and is faster, but this dashboard
 * is a single-operator local tool where build time is irrelevant and resolution
 * correctness is not. Revisit if Turbopack grows an equivalent.
 *
 * `outputFileTracingRoot` pins tracing to this repo. Without it Next walks up and
 * finds an unrelated lockfile in the home directory, then warns about ignoring it.
 *
 * ## No network from the UI
 *
 * `serverExternalPackages` keeps Prisma and pg out of the bundler: they are Node
 * libraries the server imports at runtime, not code to bundle. The dashboard issues
 * no HTTP of its own — server actions reach Postgres through Prisma directly — and
 * `tools/check-no-raw-http.ts` and ESLint both cover `app/` to keep it that way.
 */
/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['@prisma/client', '@prisma/adapter-pg', 'pg', 'pg-boss'],
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    }
    return config
  },
  // Next 16 removed the `eslint` config key; linting is `npm run lint`, which uses
  // the repo's own flat config and covers app/ including the ban on bare `fetch`.
  outputFileTracingRoot: import.meta.dirname,
}

export default nextConfig
