/**
 * Provider-agnostic copy that needs no provider in scope.
 *
 * Deliberately in `src/lib`, not `src/server/git/providers`: it never touches
 * the registry, which is what lets it be imported from a client component
 * without pulling five provider implementations and their HTTP clients into
 * the browser bundle. `supportedProviderNames` (which does read the registry)
 * stays server-side, beside the registry it reads — see
 * `spec-execution-honesty.md` §7.3.
 */

export const NEUTRAL_CHANGE_REQUEST_NOUN = "change request";

/**
 * The shared noun when every provider in scope agrees; the neutral term
 * otherwise (including when scope is empty, e.g. no repo connected yet).
 */
export function changeRequestNounFor(nouns: readonly string[]): string {
  const distinct = new Set(nouns);
  return distinct.size === 1 ? [...distinct][0]! : NEUTRAL_CHANGE_REQUEST_NOUN;
}
