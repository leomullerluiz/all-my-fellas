import { describe, expect, it } from "vitest";

import { ATTACHMENT_MIME_TYPES, validateAttachmentFiles } from "@/server/validation/attachments";

/**
 * Unit coverage for `validateAttachmentFiles`.
 *
 * The "no filename" case is tested here rather than through a real HTTP
 * request: a `multipart/form-data` part with an empty `filename=` degrades to
 * a plain text field on the wire (verified against Node's own `fetch`
 * implementation), so the only place that scenario can reach the validator
 * directly is a unit test.
 */
describe("validateAttachmentFiles", () => {
  it("accepts every allow-listed MIME type", async () => {
    for (const mimeType of ATTACHMENT_MIME_TYPES) {
      const file = new File(["content"], `file.${mimeType.split("/")[1]}`, { type: mimeType });
      const result = await validateAttachmentFiles([file]);
      expect(result.ok, `${mimeType} should be accepted`).toBe(true);
    }
  });

  it("rejects a file of an unsupported type, naming the file and its type", async () => {
    const file = new File(["MZ"], "installer.exe", { type: "application/x-msdownload" });
    const result = await validateAttachmentFiles([file]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const payload = (await result.response.json()) as { error: string };
      expect(result.response.status).toBe(400);
      expect(payload.error).toContain("installer.exe");
      expect(payload.error).toContain("application/x-msdownload");
    }
  });

  it("rejects an empty file", async () => {
    const file = new File([], "empty.json", { type: "application/json" });
    const result = await validateAttachmentFiles([file]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(400);
  });

  it("rejects a file with no filename", async () => {
    const file = new File(["{}"], "", { type: "application/json" });
    const result = await validateAttachmentFiles([file]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(400);
  });

  it("validates every file in the batch, failing on the first bad one", async () => {
    const good = new File(["ok"], "good.json", { type: "application/json" });
    const bad = new File(["MZ"], "bad.exe", { type: "application/x-msdownload" });

    const result = await validateAttachmentFiles([good, bad]);
    expect(result.ok).toBe(false);
  });

  it("returns the read bytes for a valid batch", async () => {
    const file = new File(["hello"], "note.txt", { type: "application/pdf" });
    const result = await validateAttachmentFiles([file]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(1);
      expect(result.data[0].filename).toBe("note.txt");
      expect(result.data[0].mimeType).toBe("application/pdf");
      expect(result.data[0].size).toBe(5);
      expect(result.data[0].buffer.toString()).toBe("hello");
    }
  });
});
