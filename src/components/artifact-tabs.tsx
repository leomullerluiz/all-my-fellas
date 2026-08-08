"use client";

import { useState } from "react";

import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/animate-ui/components/radix/tabs";
import { PatchBody } from "@/components/diff-viewer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { diffLines } from "@/lib/line-diff";
import { formatDateTime } from "@/lib/utils";
import { ARTIFACT_FILENAMES, type ArtifactType } from "@/server/pipeline/stages";
import type { ArtifactVersion } from "@/server/tasks/service";

export type ArtifactView = {
  id: string;
  type: ArtifactType;
  contentMd: string;
  createdAt: number;
};

/**
 * Ordered so the tabs read as the pipeline runs.
 *
 * A total mapping over `ArtifactType`, not an array: an array missing an
 * entry sorts it ahead of everything else (`indexOf` returns -1) and it could
 * then never be the tab that opens by default. `Record<ArtifactType, number>`
 * makes the compiler refuse a new artifact type with no position — see
 * `tests/artifact-tabs.test.tsx` and spec-audit-trail.md §12.1.
 */
export const ORDER: Record<ArtifactType, number> = {
  brief: 0,
  stories: 1,
  techplan: 2,
  dev_report: 3,
  verification_report: 4,
  code_review_report: 5,
  qa_report: 6,
  human_review: 7,
  homolog_report: 8,
  diff_summary: 9,
};

async function fetchArtifactBody(taskId: string, artifactId: string): Promise<string> {
  const response = await fetch(`/api/tasks/${taskId}/artifacts/${artifactId}`);
  if (!response.ok) throw new Error("Could not load that version.");
  const payload = (await response.json()) as { contentMd: string };
  return payload.contentMd;
}

/**
 * One artifact type's panel: the newest version by default, with a version
 * switcher when more than one version was produced (rework cycles) — §7.
 *
 * The tab set stays one tab per `type` (`listLatestArtifacts` already
 * guarantees that); version selection lives inside the panel instead, since
 * two rows of the same type would otherwise produce two Radix triggers
 * sharing a `value`.
 */
function ArtifactPanel({
  taskId,
  latest,
  versions,
}: {
  taskId: string;
  latest: ArtifactView;
  versions: ArtifactVersion[];
}) {
  const [selectedId, setSelectedId] = useState(latest.id);
  const [bodies, setBodies] = useState<Record<string, string>>({ [latest.id]: latest.contentMd });
  const [loading, setLoading] = useState(false);
  const [compareId, setCompareId] = useState<string | null>(null);

  if (versions.length <= 1) {
    return <pre className="artifact-body max-h-[36rem] overflow-auto">{latest.contentMd}</pre>;
  }

  const index = versions.findIndex((version) => version.id === selectedId);
  const selected = versions[index] ?? versions[0];
  const isLatest = selectedId === latest.id;

  async function ensureBody(id: string): Promise<string> {
    const cached = bodies[id];
    if (cached !== undefined) return cached;
    const body = await fetchArtifactBody(taskId, id);
    setBodies((current) => ({ ...current, [id]: body }));
    return body;
  }

  async function select(id: string) {
    setLoading(true);
    try {
      await ensureBody(id);
      setSelectedId(id);
    } catch {
      // A failed fetch leaves the previous, already-loaded version showing
      // rather than blanking the panel.
    } finally {
      setLoading(false);
    }
  }

  async function selectCompare(id: string | null) {
    if (id === null) {
      setCompareId(null);
      return;
    }
    setLoading(true);
    try {
      await ensureBody(id);
      setCompareId(id);
    } catch {
      // ignore — see `select` above.
    } finally {
      setLoading(false);
    }
  }

  const currentBody = bodies[selectedId] ?? latest.contentMd;
  const compareBody = compareId ? bodies[compareId] : undefined;
  // Comparing selected → older-or-newer: the second argument is the version
  // being viewed, so additions/removals read relative to it.
  const patch = compareId && compareBody !== undefined ? diffLines(compareBody, currentBody) : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2"
          disabled={index >= versions.length - 1 || loading}
          onClick={() => void select(versions[index + 1].id)}
        >
          ◀ older
        </Button>
        <span>
          attempt {selected?.attempt ?? "?"} · {formatDateTime(selected?.createdAt ?? latest.createdAt)}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2"
          disabled={index <= 0 || loading}
          onClick={() => void select(versions[index - 1].id)}
        >
          newer ▶
        </Button>
        {isLatest ? <Badge tone="success">latest</Badge> : <Badge tone="warning">not latest</Badge>}
        {versions.length > 1 ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2"
            onClick={() =>
              void selectCompare(
                compareId ? null : (versions.find((version) => version.id !== selectedId)?.id ?? null),
              )
            }
          >
            {compareId ? "close compare" : "compare…"}
          </Button>
        ) : null}
        {compareId ? (
          <select
            aria-label="Compare against"
            className="h-6 rounded border border-border bg-transparent px-1 text-[11px]"
            value={compareId}
            onChange={(event) => void selectCompare(event.target.value)}
          >
            {versions
              .filter((version) => version.id !== selectedId)
              .map((version) => (
                <option key={version.id} value={version.id}>
                  attempt {version.attempt} · {formatDateTime(version.createdAt)}
                </option>
              ))}
          </select>
        ) : null}
      </div>

      {patch !== null ? (
        <div className="max-h-[36rem] overflow-auto rounded-md border border-border">
          <PatchBody patch={patch} />
        </div>
      ) : (
        <pre className="artifact-body max-h-[36rem] overflow-auto">{currentBody}</pre>
      )}
    </div>
  );
}

export function ArtifactTabs({
  artifacts,
  taskId,
  versions = [],
}: {
  artifacts: ArtifactView[];
  /** Needed to fetch an older version's body on demand; omit to disable the switcher. */
  taskId?: string;
  /** Every artifact's version metadata for this task — `listArtifactVersions`. */
  versions?: ArtifactVersion[];
}) {
  const sorted = [...artifacts].sort((a, b) => ORDER[a.type] - ORDER[b.type]);

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
          {sorted.map((artifact) =>
            taskId ? (
              <TabsContent key={artifact.id} value={artifact.type}>
                <ArtifactPanel
                  taskId={taskId}
                  latest={artifact}
                  versions={versions.filter((version) => version.type === artifact.type)}
                />
              </TabsContent>
            ) : (
              <TabsContent key={artifact.id} value={artifact.type}>
                <pre className="artifact-body max-h-[36rem] overflow-auto">{artifact.contentMd}</pre>
              </TabsContent>
            ),
          )}
        </CardBody>
      </Tabs>
    </Card>
  );
}
