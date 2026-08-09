import type { ReactNode } from "react";

import { GateApprovalNotifier } from "@/components/gate-approval-notifier";
import { Nav } from "@/components/nav";
import { getSettings } from "@/server/settings/store";
import { resolveWorkerHealth } from "@/server/worker/health";

/** Chrome shared by every screen of the dashboard. */
export default function DashboardLayout({ children }: { children: ReactNode }) {
  const { theme, notifications } = getSettings();

  return (
    <>
      <Nav initialTheme={theme} initialWorkerHealth={resolveWorkerHealth()} />
      <GateApprovalNotifier notifications={notifications} />
      <main className="mx-auto w-full max-w-[1600px] flex-1 px-6 py-6">{children}</main>
      <footer className="border-t border-border px-6 py-3 text-center text-[11px] text-muted">
        Runs locally. The pipeline only ever opens change requests — merging stays with you.
      </footer>
    </>
  );
}
