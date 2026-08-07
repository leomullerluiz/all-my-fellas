"use client";

import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/animate-ui/components/radix/tabs";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { ARTIFACT_FILENAMES, type ArtifactType } from "@/server/pipeline/stages";

export type ArtifactView = {
  id: string;
  type: ArtifactType;
  contentMd: string;
  createdAt: number;
};

/**
 * Ordered so the tabs read as the pipeline runs.
 *
 * Must list every `ArtifactType` — a type missing here sorts ahead of
 * everything else (`indexOf` returns -1) and can therefore never be the tab
 * that opens by default (`sorted.at(-1)` below). See `tests/artifact-tabs.test.tsx`.
 */
export const ORDER: ArtifactType[] = [
  "brief",
  "stories",
  "techplan",
  "dev_report",
  "verification_report",
  "code_review_report",
  "qa_report",
  "human_review",
  "homolog_report",
];

export function ArtifactTabs({ artifacts }: { artifacts: ArtifactView[] }) {
  const sorted = [...artifacts].sort(
    (a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type),
  );

  if (sorted.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Artifacts</CardTitle>
        </CardHeader>
        <CardBody>
          <p className="text-xs text-muted">
            Nothing produced yet. Each stage writes one Markdown document, and only that
            document is handed to the next stage.
          </p>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      {/*
       * `Tabs` provides the active-tab context for both the header's
       * triggers and the body's panels, so it wraps both — the pipeline's
       * own gap-2 is dropped in favor of the header's border-b, matching
       * how Card's other consumers separate header from body.
       */}
      <Tabs defaultValue={sorted.at(-1)!.type} className="gap-0">
        <CardHeader className="flex flex-wrap items-center gap-1">
          <TabsList className="h-auto w-full flex-wrap justify-start gap-1 bg-transparent p-0">
            {sorted.map((artifact) => (
              <TabsTrigger
                key={artifact.id}
                value={artifact.type}
                className="h-auto flex-none rounded-md px-2.5 py-1 font-mono text-[11px] font-normal text-muted transition-colors hover:text-foreground data-[state=active]:text-accent"
              >
                {ARTIFACT_FILENAMES[artifact.type]}
              </TabsTrigger>
            ))}
          </TabsList>
        </CardHeader>
        <CardBody>
          {sorted.map((artifact) => (
            <TabsContent key={artifact.id} value={artifact.type}>
              <pre className="artifact-body max-h-[36rem] overflow-auto">{artifact.contentMd}</pre>
            </TabsContent>
          ))}
        </CardBody>
      </Tabs>
    </Card>
  );
}
