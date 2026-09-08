/**
 * robots-parser 3.0.1 ships an index.d.ts whose first line is the shorthand
 * ambient declaration `declare module 'robots-parser';` followed by a real
 * `export default function`. TypeScript resolves that to the module namespace
 * rather than the callable, so the default import is not callable.
 *
 * This is the published surface, declared correctly, mapped in via tsconfig
 * `paths`. Runtime resolution is unaffected — it still loads the real package.
 */
declare module 'robots-parser' {
  export interface Robot {
    isAllowed(url: string, ua?: string): boolean | undefined
    isDisallowed(url: string, ua?: string): boolean | undefined
    getMatchingLineNumber(url: string, ua?: string): number
    getCrawlDelay(ua?: string): number | undefined
    getSitemaps(): string[]
    getPreferredHost(): string | null
  }
  export default function robotsParser(url: string, robotstxt: string): Robot
}
