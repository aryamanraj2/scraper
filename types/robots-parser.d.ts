/**
 * robots-parser 3.0.1 ships an index.d.ts whose first line is the shorthand
 * ambient declaration `declare module 'robots-parser';` followed by a real
 * `export default function`. TypeScript resolves that to the module namespace
 * rather than the callable, so the default import is not callable.
 *
 * This is the published surface, declared correctly, as an ambient module block.
 * It is picked up because `types/**\/*.d.ts` is in tsconfig `include`, and an
 * ambient `declare module` wins over the package's own typings.
 *
 * It must NOT be wired in through tsconfig `paths`. F0 did that, and `tsc` was
 * happy — but `tsx` honours `paths` at RUNTIME too, so it resolved the import to
 * this declaration file and every tool that touched robots.ts died with
 * "The requested module 'robots-parser' does not provide an export named
 * 'default'". The suite never caught it because vitest resolves differently.
 * See docs/F2-HANDOVER.md §4.
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
