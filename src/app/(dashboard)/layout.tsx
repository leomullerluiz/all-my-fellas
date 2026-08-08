import type { ReactNode } from "react";

import { Nav } from "@/components/nav";
import { getSettings } from "@/server/settings/store";

/** Chrome shared by every screen of the dashboard. */
export default function DashboardLayout({ children }: { children: ReactNode }) {
  const { theme } = getSettings();

  return (
    <>
      <Nav initialTheme={theme} />
      <main className="mx-auto w-full max-w-[1600px] flex-1 px-6 py-6">{children}</main>
      <footer className="border-t border-border px-6 py-3 text-center text-[11px] text-muted">
        Runs locally. The pipeline only ever opens change requests — merging stays with you.
      </footer>
    </>
  );
}
