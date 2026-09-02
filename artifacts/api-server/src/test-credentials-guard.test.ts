import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { restoreOrphanedSnapshot } from "./test-credentials-guard";

describe("credentials guard orphan recovery", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it("quarantines malformed JSON without querying or modifying credentials", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "credentials-guard-"));
    tempDirs.push(dir);
    const snapshotFile = path.join(dir, "snapshot.json");
    fs.writeFileSync(snapshotFile, '{"version":1,"snapshots":[');
    const client = { query: vi.fn() };
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await restoreOrphanedSnapshot(
      client as unknown as Parameters<typeof restoreOrphanedSnapshot>[0],
      snapshotFile,
    );

    expect(client.query).not.toHaveBeenCalled();
    expect(fs.existsSync(snapshotFile)).toBe(false);
  });

  it("rejects structurally invalid snapshots before issuing destructive SQL", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "credentials-guard-"));
    tempDirs.push(dir);
    const snapshotFile = path.join(dir, "snapshot.json");
    fs.writeFileSync(
      snapshotFile,
      JSON.stringify({
        version: 1,
        createdAt: new Date().toISOString(),
        snapshots: [
          { table: "app_credentials; DROP TABLE tenants", columns: ["id"], rows: [] },
        ],
      }),
    );
    const client = { query: vi.fn() };
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await restoreOrphanedSnapshot(
      client as unknown as Parameters<typeof restoreOrphanedSnapshot>[0],
      snapshotFile,
    );

    expect(client.query).not.toHaveBeenCalled();
    expect(fs.existsSync(snapshotFile)).toBe(false);
  });

  it("rolls back a damaged table and restores intact tables from the same snapshot", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "credentials-guard-"));
    tempDirs.push(dir);
    const snapshotFile = path.join(dir, "snapshot.json");
    fs.writeFileSync(
      snapshotFile,
      JSON.stringify({
        version: 1,
        createdAt: new Date().toISOString(),
        snapshots: [
          {
            table: "app_credentials",
            columns: ["id", "credentials"],
            rows: [{ id: 1, credentials: "malformed database JSON" }],
          },
          {
            table: "video_gen_settings",
            columns: ["id", "provider"],
            rows: [{ id: 2, provider: "replicate" }],
          },
        ],
      }),
    );
    const restoreError = new Error("invalid input syntax for type json");
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(restoreError)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined),
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await restoreOrphanedSnapshot(
      client as unknown as Parameters<typeof restoreOrphanedSnapshot>[0],
      snapshotFile,
    );

    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN",
      "DELETE FROM app_credentials",
      'INSERT INTO app_credentials ("id", "credentials") VALUES ($1, $2)',
      "ROLLBACK",
      "BEGIN",
      "DELETE FROM video_gen_settings",
      'INSERT INTO video_gen_settings ("id", "provider") VALUES ($1, $2)',
      "COMMIT",
    ]);
    expect(client.query.mock.calls[6]?.[1]).toEqual([2, "replicate"]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("app_credentials"),
    );
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining("malformed database JSON"),
    );
    expect(fs.existsSync(snapshotFile)).toBe(false);
  });
});
