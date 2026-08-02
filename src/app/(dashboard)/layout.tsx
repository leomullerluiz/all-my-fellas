import type { ReactNode } from "react";

import { Nav } from "@/components/nav";

/** Chrome shared by every screen of the dashboard. */
export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <Nav />
      <main className="mx-auto w-full max-w-[1600px] flex-1 px-6 py-6">{children}</main>
      <footer className="border-t border-border px-6 py-3 text-center text-[11px] text-muted">
        Runs locally. Merges always happen on GitHub — the pipeline only opens pull requests.
      </footer>
    </>
  );
}
