import { GithubMark } from "@/components/icons";
import { REPO_URL } from "@/lib/content";

const LINKS = [
  { href: `${REPO_URL}#readme`, label: "Documentation" },
  { href: `${REPO_URL}/tree/main/prompts`, label: "Role prompts" },
  { href: "https://code.claude.com/docs/en/agent-sdk", label: "Claude Agent SDK" },
];

export function SiteFooter() {
  return (
    <footer className="mx-auto w-full max-w-[1120px] px-6 py-10">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
        <div className="flex items-center gap-2">
          <span className="inline-block size-2 rounded-full bg-accent" aria-hidden />
          <span className="text-sm font-semibold tracking-tight">All My Fellas</span>
        </div>

        <nav className="flex flex-wrap items-center gap-x-5 gap-y-2">
          {LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-muted transition-colors hover:text-foreground"
            >
              {link.label}
            </a>
          ))}
        </nav>

        <a
          href={REPO_URL}
          target="_blank"
          rel="noreferrer"
          className="ml-auto flex items-center gap-2 text-xs text-muted transition-colors hover:text-foreground"
        >
          <GithubMark className="size-4" />
          leomullerluiz/all-my-fellas
        </a>
      </div>

      <p className="mt-6 border-t border-border pt-4 text-[11px] leading-relaxed text-muted">
        Runs locally. The pipeline only opens change requests — merging always happens on your git
        host.
      </p>
    </footer>
  );
}
