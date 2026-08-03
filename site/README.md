# site/

The public landing page for All My Fellas, published to GitHub Pages at
<https://leomullerluiz.github.io/all-my-fellas/>.

It is a **separate Next.js app** with its own `package.json` and `node_modules`.
Nothing here imports from the pipeline: the dashboard needs SQLite, a worker
process and a live SSE connection, none of which survive a static export. Keeping
the two apart means the site can be a pure `output: "export"` build and the
pipeline never grows a dependency it does not use.

```bash
cd site
npm install
npm run dev      # http://localhost:3300
npm run build    # writes ./out
```

## What is copied, and why

`src/app/globals.css` carries the same dark-first palette as
`src/app/globals.css` in the app — the same hex values, the same `data-theme`
contract, the same `prefers-color-scheme` fallback. It is a copy rather than an
import: a landing page whose colours silently changed because someone tweaked a
dashboard token would be a surprise, not a feature.

Every claim on the page lives in [`src/lib/content.ts`](src/lib/content.ts),
sourced from the root README. When the pipeline changes, that file is the one
place the site has to follow.

## Animate UI

The animated components under `src/components/animate-ui/`, plus `src/hooks/`
and `src/lib/get-strict-context.tsx`, are vendored verbatim from the
[Animate UI](https://animate-ui.com) registry — that is how the library is meant
to be consumed, the same copy-in model as shadcn/ui. They are left byte-identical
to upstream and excluded from lint so they stay diffable; local styling is
applied from the outside via `className`.

To add another component:

```bash
cd site
npx shadcn@latest add @animate-ui/primitives-effects-blur
```

The registry uses shadcn/ui's token names (`bg-primary`, `text-muted-foreground`,
`ring`). `globals.css` aliases those onto the All My Fellas palette in its
`@theme inline` block, so a newly added component picks up the project's colours
without being edited. It also redefines Tailwind's `dark:` variant to match the
palette's own light/dark condition, since the stock variant keys off
`prefers-color-scheme` alone and would disagree the moment someone picks a theme
by hand.

## Deployment

[`.github/workflows/deploy-site.yml`](../.github/workflows/deploy-site.yml)
builds this directory and publishes `site/out` on every push to `main` that
touches `site/`. Set **Settings → Pages → Source** to **GitHub Actions** once;
after that it is automatic.

A project site is served from `/<repo>`, so the workflow passes
`NEXT_PUBLIC_BASE_PATH=/all-my-fellas` at build time. `next dev` leaves it unset
and serves from the root. `public/.nojekyll` is what stops Pages from discarding
the `_next/` directory, whose leading underscore Jekyll would otherwise treat as
private.
