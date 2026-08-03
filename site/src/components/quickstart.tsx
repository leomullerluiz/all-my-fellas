"use client";

import { CopyButton } from "@/components/animate-ui/components/buttons/copy";
import {
  Tabs,
  TabsContent,
  TabsContents,
  TabsHighlight,
  TabsHighlightItem,
  TabsList,
  TabsTrigger,
} from "@/components/animate-ui/primitives/animate/tabs";
import { Reveal } from "@/components/reveal";
import { COMMAND_TABS } from "@/lib/content";

export function Quickstart() {
  return (
    <Reveal>
      <Tabs defaultValue={COMMAND_TABS[0]!.value} className="rounded-lg border border-border bg-surface">
        <TabsList className="flex flex-wrap gap-1 border-b border-border p-2">
          {/* One highlight element slides between triggers; each trigger just
              reports its own bounds. */}
          <TabsHighlight className="rounded-md bg-surface-raised">
            {COMMAND_TABS.map((tab) => (
              <TabsHighlightItem key={tab.value} value={tab.value}>
                <TabsTrigger
                  value={tab.value}
                  className="cursor-pointer rounded-md px-3 py-1.5 text-sm text-muted transition-colors data-[state=active]:font-medium data-[state=active]:text-foreground"
                >
                  {tab.label}
                </TabsTrigger>
              </TabsHighlightItem>
            ))}
          </TabsHighlight>
        </TabsList>

        <TabsContents className="p-2">
          {COMMAND_TABS.map((tab) => (
            <TabsContent key={tab.value} value={tab.value}>
              <div className="relative">
                <CopyButton
                  content={tab.code}
                  size="xs"
                  variant="ghost"
                  aria-label={`Copy the ${tab.label.toLowerCase()} commands`}
                  className="absolute right-2 top-2 z-10 border border-border bg-surface text-muted hover:bg-surface-raised hover:text-foreground dark:hover:bg-surface-raised"
                />
                <pre className="overflow-x-auto rounded-md bg-background p-4 pr-14 font-mono text-[12.5px] leading-relaxed">
                  <code>{tab.code}</code>
                </pre>
              </div>
              <p className="px-1 pb-1 pt-3 text-xs leading-relaxed text-muted">{tab.caption}</p>
            </TabsContent>
          ))}
        </TabsContents>
      </Tabs>
    </Reveal>
  );
}
