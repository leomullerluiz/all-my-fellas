# Mechanical verification

Between `DEVELOPMENT` and `CODE_REVIEW` the worker runs the repository's own
install, build, test and lint commands and routes the task on the real exit
codes. No agent is involved, no agent is asked whether the tests passed, and no
agent can talk around the result.

This is the difference between *"QA says the suite is green"* and *"the suite
exited 0"*.

---

## Configuring the commands

Commands belong to the **repository connection**, not to the task — they are the
same for every task that targets that repository.

**At registration.** The connection form clones the repository into a throwaway
directory, reads its manifests and prefills whatever it recognises. Detection
never saves anything by itself: a stored command is always something a human
accepted.

| Detected from | Install | Build | Test | Lint |
|---|---|---|---|---|
| `package.json` + `pnpm-lock.yaml` | `pnpm install --frozen-lockfile` | `pnpm build` | `pnpm test` | `pnpm lint` |
| `package.json` + `package-lock.json` | `npm ci` | `npm run build` | `npm test` | `npm run lint` |
| `package.json` + `yarn.lock` | `yarn install --frozen-lockfile` | `yarn build` | `yarn test` | `yarn lint` |
| `go.mod` | `go mod download` | `go build ./...` | `go test ./...` | `go vet ./...` |
| `Cargo.toml` | — | `cargo build` | `cargo test` | `cargo clippy` |
| `pyproject.toml` + `poetry.lock` | `poetry install` | — | `poetry run pytest` | `poetry run ruff check .` |
| `pyproject.toml` | `pip install -e .` | — | `pytest` | `ruff check .` |
| `Makefile` | — | `make build` | `make test` | `make lint` |

A JavaScript command is only offered when the matching key actually exists in
`package.json`'s `scripts`; a `make` command only when the target is declared in
the `Makefile`. Ecosystems are checked independently, so a repository that is
both Go and Make gets the union, and a failure to read one manifest never
suppresses another.

**Afterwards.** *Repositories* → **Edit commands** on the connection, or
`PATCH /api/repos/:id`. Any of the four may be empty. There is also a timeout per
command, `verifyTimeoutSeconds`, defaulting to **600**.

Leave everything empty and verification is `skipped` — reported as skipped
everywhere it appears, never rendered as a pass.

---

## What happens when it runs

Commands run in order — install, build, test, lint — from the task's workspace,
and stop at the first non-zero exit.

Each command is spawned directly, with **no shell**. Its environment is an
allowlist (`PATH`, `HOME`/`USERPROFILE`, `LANG`, `LC_ALL`, `TMPDIR`/`TEMP`,
`SystemRoot`) — every LLM key and every git credential the pipeline holds is
dropped rather than filtered by name, because unlike an agent's guarded tools a
child process can make network calls. The working directory is checked to be
inside the workspace before anything is spawned. On timeout the whole process
*tree* is killed, `SIGTERM` then `SIGKILL` after a grace period, so a test runner
that spawned a database does not leave one behind.

Output is streamed to the live log as it arrives (buffered, stderr tinted
differently), capped per command so a runaway build cannot flood the page. The
tail of each stream is persisted, along with the exact command, its exit code,
whether it timed out, and how long it took.

## Outcomes

| Outcome | Meaning | Where the task goes |
|---|---|---|
| `passed` | every configured command exited 0 | `CODE_REVIEW` (or `QA`, if code review is skipped for this task) |
| `skipped` | no commands configured | same as `passed`, but reported as skipped |
| `failed` | a command exited non-zero | back to `DEVELOPMENT`, charged to the shared rework budget |
| `errored` | the commands could not run at all — a missing toolchain, an install that cannot even start | `FAILED`. This is an environment problem, not the code's fault, and it is never reported as a code failure |

When a `failed` verification exhausts the rework budget, the terminal message
names the command that broke rather than saying "verification failed".

## What the rest of the pipeline sees

- **The Developer**, on a rework cycle, gets the failing output as part of its
  prompt.
- **QA and Homologation** receive the verification report as a labelled
  supplement — *"Mechanical verification (run by the pipeline, not by you)"*.
  QA's own prompt is narrowed to match: it verifies acceptance criteria and does
  not claim to have run a suite.
- **The gates** show a verification badge, so a human approving a diff can see
  what mechanically passed.
- **The pull request body** carries a Verification section.
- **`verification_runs`** keeps one row per command, owned by the stage run that
  produced it, and outlives the workspace — "what passed" stays answerable after
  the clone is deleted.

## Trust model

These commands are arbitrary programs, executed on the machine running the
worker, outside the `canUseTool` guard that confines every agent tool call. That
is deliberate and it is the one place in the product where that is true.

The justification is provenance: the commands come from the operator, typed into
the same dashboard that already configures which environment variable holds a
git token, and never from a model. An agent cannot add, edit or invoke one. If
you would not run the repository's own `npm test` on your machine, do not
configure it here.
