import simpleGit, { type SimpleGit } from "simple-git";

/**
 * A git client allowed to carry `GitTransport.configArgs`.
 *
 * Those args clear `credential.helper` so git can never block on a login
 * nobody is there to answer — see `NON_INTERACTIVE` in `providers/types.ts`
 * for why that is the setting that matters. simple-git rejects any
 * `-c credential.helper` by default, since a helper value is a program it
 * would run, so the override has to be asked for explicitly.
 *
 * Granting it is safe here and only here: the value is a constant of ours,
 * never anything a repository or a user supplies, and it takes a capability
 * away from git rather than adding one. Every other client in this layer
 * keeps the check on, which is why this is scoped to the three remote
 * operations that need it — clone, detection clone, and push.
 */
export function remoteGit(baseDir?: string): SimpleGit {
  return simpleGit(baseDir, { unsafe: { allowUnsafeCredentialHelper: true } });
}
