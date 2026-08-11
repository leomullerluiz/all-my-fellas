# Documentation

The [root README](../README.md) is the overview: what the pipeline is, how to
install it, what each stage does, and what it deliberately does not do. These
pages are the depth behind it.

| Page | What it covers |
|---|---|
| [`llm-providers.md`](llm-providers.md) | Claude, ChatGPT and Gemini: credentials, the model tier picker, and the behaviour differences between them |
| [`verification.md`](verification.md) | The mechanical install/build/test/lint stage: configuring commands per repository, what each outcome routes to, and what is captured |
| [`operations.md`](operations.md) | Running it unattended: spend ceilings and quota enforcement, pause and hold, cancel, worker liveness, notifications, API tokens, backup and retention |
| [`audit-trail.md`](audit-trail.md) | What is recorded for every run, where to read it, and how long it is kept |
| [`api.md`](api.md) | The complete HTTP API, including the optional bearer-token gate |

## A note on `spec-*.md` references in the code

Source comments frequently cite documents like `spec-audit-trail.md §11` or
`spec-board-at-scale.md §5`. Those were the design specifications each feature
was built from. They lived in `docs/spec/`, they have all been implemented, and
they were removed once that was true — a specification that describes shipped
behaviour competes with the code for authority, and loses.

The citations are left in place as history: they say *why* a decision was made
and what alternatives were rejected, which the code cannot. To read one, use
git:

```bash
git log --diff-filter=D --name-only -- 'docs/spec/*'   # find the removing commit
git show <commit>^:docs/spec/spec-audit-trail.md       # read the file as it was
```

Behaviour is documented here and in the root README. If the two ever disagree
with a retired spec, these pages are right and the spec is a historical record.
