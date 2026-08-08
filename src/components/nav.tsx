"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { ThemeSwitch } from "@/components/theme-switch";
import { WorkerHealthDot } from "@/components/worker-health-dot";
import { cn } from "@/lib/utils";
import type { Theme } from "@/server/settings/store";
import type { WorkerHealth } from "@/server/worker/health";

const LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/tasks/new", label: "New task" },
  { href: "/repos", label: "Repositories" },
  { href: "/usage", label: "Costs" },
  { href: "/settings", label: "Settings" },
];

export function Nav({
  initialTheme,
  initialWorkerHealth,
}: {
  initialTheme: Theme;
  initialWorkerHealth: WorkerHealth;
}) {
  const pathname = usePathname();

  return (
    <header className="border-b border-border bg-surface">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3">
        <Link href="/" className="flex items-center gap-2">
          <WorkerHealthDot initialHealth={initialWorkerHealth} />
          <span className="text-sm font-semibold tracking-tight">All My Fellas</span>
        </Link>

        <nav className="flex flex-wrap items-center gap-1">
          {LINKS.map((link) => {
            const active =
              link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm transition-colors",
                  active
                    ? "bg-surface-raised font-medium text-foreground"
                    : "text-muted hover:bg-surface-raised hover:text-foreground",
                )}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto">
          <ThemeSwitch initialTheme={initialTheme} />
        </div>
      </div>
    </header>
  );
}
