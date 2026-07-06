import { describe, it, expect } from "vitest";
import { ObjectStorageService, ObjectNotFoundError } from "./objectStorage";

/**
 * Tenant-scope enforcement guards (B1). These assert the ownership prefix check
 * WITHOUT mocking, exercising the real method: a mismatched tenant is rejected
 * before any storage/GCS access, so a leaked or crafted `/objects/...` path
 * cannot cross tenant boundaries.
 */
describe("ObjectStorageService tenant scoping", () => {
  const svc = new ObjectStorageService();

  it("rejects a path owned by a different tenant", async () => {
    await expect(
      svc.getObjectEntityFile("/objects/2/uploads/x.png", 1),
    ).rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it("is not fooled by numeric-prefix confusion (tenant 1 vs 10)", async () => {
    await expect(
      svc.getObjectEntityFile("/objects/10/uploads/x.png", 1),
    ).rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it("rejects a legacy, non-namespaced path", async () => {
    await expect(
      svc.getObjectEntityFile("/objects/uploads/x.png", 1),
    ).rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it("rejects a path outside the /objects/ root", async () => {
    await expect(
      svc.getObjectEntityFile("/nope/1/x.png", 1),
    ).rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it("getSignedDownloadURL enforces the same tenant scope", async () => {
    await expect(
      svc.getSignedDownloadURL("/objects/2/uploads/x.png", 1),
    ).rejects.toBeInstanceOf(ObjectNotFoundError);
  });
});
