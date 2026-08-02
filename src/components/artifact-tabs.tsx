"use client";

import { useState } from "react";

import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { ARTIFACT_FILENAMES, type ArtifactType } from "@/server/pipeline/stages";

export type ArtifactView = {
  id: string;
  type: ArtifactType;
  contentMd: string;
  createdAt: number;
};

/** Ordered so the tabs read as the pipeline runs. */
const ORDER: ArtifactType[] = [
  "brief",
  "stories",
  "techplan",
  "dev_report",
  "qa_report",
  "homolog_report",
];

export function ArtifactTabs({ artifacts }: { artifacts: ArtifactView[] }) {
  const sorted = [...artifacts].sort(
    (a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type),
  );
  const [active, setActive] = useState<ArtifactType | null>(sorted.at(-1)?.type ?? null);

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

  const current = sorted.find((artifact) => artifact.type === active) ?? sorted[0];

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center gap-1">
        {sorted.map((artifact) => (
          <button
            key={artifact.id}
            type="button"
            onClick={() => setActive(artifact.type)}
            aria-pressed={artifact.type === current.type}
            className={cn(
              "rounded-md px-2.5 py-1 font-mono text-[11px] transition-colors",
              artifact.type === current.type
                ? "bg-accent/15 text-accent"
                : "text-muted hover:bg-surface-raised hover:text-foreground",
            )}
          >
            {ARTIFACT_FILENAMES[artifact.type]}
          </button>
        ))}
      </CardHeader>
      <CardBody>
        <pre className="artifact-body max-h-[36rem] overflow-auto">{current.contentMd}</pre>
      </CardBody>
    </Card>
  );
}
