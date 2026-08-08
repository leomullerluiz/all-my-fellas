import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * S1 — text-shaped attachments reach the roles that plan the work.
 *
 * Exercised directly against `buildAttachmentSupplements` rather than through
 * a full `executeAgentStage` run: the function is pure given the database and
 * a role, and every role that receives attachments (`STAKEHOLDER_REFINEMENT`,
 * `DEVELOPMENT`) can be exercised without a real git workspace.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "execute-attachments-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
process.env.WORKSPACES_DIR = path.join(tempDir, "workspaces");

type Service = typeof import("@/server/tasks/service");
type AttachmentsModule = typeof import("@/server/pipeline/attachments");
type RolesModule = typeof import("@/server/agents/roles");

let service: Service;
let attachments: AttachmentsModule;
let roles: RolesModule;
let repoId: string;
let counter = 0;

// A minimal, hand-built single-page PDF whose content stream is the literal
// text "Hello World" — small enough to inline, real enough for `pdf-parse`
// to extract text from.
const MINIMAL_PDF = Buffer.from(
  `%PDF-1.1
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 200 200] /Contents 5 0 R >>
endobj
4 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
5 0 obj
<< /Length 44 >>
stream
BT /F1 24 Tf 10 100 Td (Hello World) Tj ET
endstream
endobj
trailer
<< /Size 6 /Root 1 0 R >>
%%EOF`,
  "latin1",
);

beforeAll(async () => {
  service = await import("@/server/tasks/service");
  attachments = await import("@/server/pipeline/attachments");
  roles = await import("@/server/agents/roles");

  repoId = service.createRepo({
    name: "acme/attachments",
    url: "https://github.com/acme/attachments",
    defaultBranch: "main",
  }).id;
});

afterAll(async () => {
  const { closeDatabase } = await import("@/server/db/client");
  closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function newTask() {
  counter += 1;
  return service.createTask({
    repoId,
    title: `Attachments task ${counter}`,
    description: "A description long enough to pass validation upstream.",
    priority: "medium",
  });
}

describe("buildAttachmentSupplements (S1)", () => {
  it("returns no supplements for a role with attachments: 'none'", async () => {
    const task = newTask();
    service.insertAttachments(task.id, [
      { filename: "spec.json", mimeType: "application/json", size: 2, buffer: Buffer.from("{}") },
    ]);

    const result = await attachments.buildAttachmentSupplements(task.id, roles.ROLES.CODE_REVIEW);
    expect(result).toEqual([]);
  });

  it("returns no supplements for a task with no attachments — no empty section", async () => {
    const task = newTask();
    const result = await attachments.buildAttachmentSupplements(task.id, roles.ROLES.DEVELOPMENT);
    expect(result).toEqual([]);
  });

  it("inlines a JSON attachment as a labelled, fenced supplement", async () => {
    const task = newTask();
    service.insertAttachments(task.id, [
      { filename: "schema.json", mimeType: "application/json", size: 7, buffer: Buffer.from('{"a":1}') },
    ]);

    const result = await attachments.buildAttachmentSupplements(task.id, roles.ROLES.DEVELOPMENT);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("Attachment: schema.json");
    expect(result[0].fenced).toBe(true);
    expect(result[0].body).toContain('{"a":1}');
  });

  it("inlines an XML attachment the same way", async () => {
    const task = newTask();
    service.insertAttachments(task.id, [
      { filename: "data.xml", mimeType: "application/xml", size: 20, buffer: Buffer.from("<root>ok</root>") },
    ]);

    const result = await attachments.buildAttachmentSupplements(task.id, roles.ROLES.PO_REFINEMENT);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("Attachment: data.xml");
    expect(result[0].body).toContain("<root>ok</root>");
  });

  it("extracts text from a PDF attachment", async () => {
    const task = newTask();
    service.insertAttachments(task.id, [
      { filename: "spec.pdf", mimeType: "application/pdf", size: MINIMAL_PDF.length, buffer: MINIMAL_PDF },
    ]);

    const result = await attachments.buildAttachmentSupplements(task.id, roles.ROLES.STAKEHOLDER_REFINEMENT);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("Attachment: spec.pdf");
    expect(result[0].body).toContain("Hello World");
  });

  it("skips images — they travel through `media` (stories.md S5), never as text", async () => {
    const task = newTask();
    service.insertAttachments(task.id, [
      { filename: "mock.png", mimeType: "image/png", size: 3, buffer: Buffer.from([1, 2, 3]) },
    ]);

    const result = await attachments.buildAttachmentSupplements(task.id, roles.ROLES.DEVELOPMENT);
    expect(result).toEqual([]);
  });

  it("a 'documents' role gets JSON/PDF text but this module never sees images either way", async () => {
    const task = newTask();
    service.insertAttachments(task.id, [
      { filename: "schema.json", mimeType: "application/json", size: 7, buffer: Buffer.from('{"a":1}') },
      { filename: "mock.png", mimeType: "image/png", size: 3, buffer: Buffer.from([1, 2, 3]) },
    ]);

    const result = await attachments.buildAttachmentSupplements(task.id, roles.ROLES.ARCHITECTURE);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("Attachment: schema.json");
  });

  it("truncates a single attachment's text at the per-attachment cap, with a marker", async () => {
    const task = newTask();
    const big = "x".repeat(attachments.MAX_ATTACHMENT_CHARS + 1000);
    service.insertAttachments(task.id, [
      { filename: "big.json", mimeType: "application/json", size: big.length, buffer: Buffer.from(big) },
    ]);

    const result = await attachments.buildAttachmentSupplements(task.id, roles.ROLES.DEVELOPMENT);
    expect(result).toHaveLength(1);
    expect(result[0].body.length).toBeLessThan(big.length);
    expect(result[0].body).toContain("truncated");
  });

  it("omits attachments over the per-stage cap, listing the rest by filename and size", async () => {
    const task = newTask();
    const chunk = "x".repeat(attachments.MAX_ATTACHMENT_CHARS);
    // Four attachments at the per-attachment cap (800,000 chars combined)
    // comfortably exceed the 500,000-char per-stage cap by the fourth one.
    service.insertAttachments(task.id, [
      { filename: "a.json", mimeType: "application/json", size: chunk.length, buffer: Buffer.from(chunk) },
      { filename: "b.json", mimeType: "application/json", size: chunk.length, buffer: Buffer.from(chunk) },
      { filename: "c.json", mimeType: "application/json", size: chunk.length, buffer: Buffer.from(chunk) },
      { filename: "d.json", mimeType: "application/json", size: chunk.length, buffer: Buffer.from(chunk) },
    ]);

    const result = await attachments.buildAttachmentSupplements(task.id, roles.ROLES.DEVELOPMENT);
    const omitted = result.find((supplement) => supplement.label === "Attachments omitted for size");
    expect(omitted).toBeDefined();
    expect(omitted!.body).toContain("d.json");
  });
});
