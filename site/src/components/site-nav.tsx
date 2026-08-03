"use client";

import { Highlight } from "@/components/animate-ui/primitives/effects/highlight";
import {
  ScrollProgress,
  ScrollProgressProvider,
} from "@/components/animate-ui/primitives/animate/scroll-progress";
import { GithubMark } from "@/components/icons";
import { ThemeToggle } from "@/components/theme-toggle";
import { REPO_URL } from "@/lib/content";

const LINKS = [
  { href: "#pipeline", label: "Pipeline" },
  { href: "#why", label: "Why" },
  { href: "#guardrails", label: "Guardrails" },
  { href: "#repositories", label: "Repositories" },
  { href: "#start", label: "Get started" },
];

export function SiteNav() {
  return (
    <ScrollProgressProvider global>
      <header className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1120px] flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3">
          <a href="#top" className="flex items-center gap-2">
            <span className="inline-block size-2 rounded-full bg-accent animate-pipeline-pulse" aria-hidden />
            <span className="text-sm font-semibold tracking-tight">All My Fellas</span>
          </a>

          {/*
           * Same pill treatment as the dashboard's nav, except the background is
           * a single shared element that slides between items instead of one
           * background per link fading in and out.
           */}
          <nav className="hidden items-center gap-1 md:flex">
            <Highlight
              hover
              className="rounded-md bg-surface-raised"
              transition={{ type: "spring", stiffness: 320, damping: 32 }}
            >
              {LINKS.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  className="block rounded-md px-3 py-1.5 text-sm text-muted transition-colors hover:text-foreground"
                >
                  {link.label}
                </a>
              ))}
            </Highlight>
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="flex h-8 items-center gap-2 rounded-md border border-border bg-surface px-3 text-sm text-muted transition-colors hover:bg-surface-raised hover:text-foreground"
            >
              <GithubMark className="size-4" />
              <span className="hidden sm:inline">GitHub</span>
            </a>
            <ThemeToggle />
          </div>
        </div>

        {/* Reading position, pinned to the header's bottom edge. */}
        <ScrollProgress
          mode="width"
          className="absolute inset-x-0 bottom-0 h-px origin-left bg-accent"
        />
      </header>
    </ScrollProgressProvider>
  );
}
