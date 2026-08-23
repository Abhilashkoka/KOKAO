import { Router, type IRouter, type Request, type Response } from "express";
import { Readable } from "stream";
import {
  RequestUploadUrlBody,
  RequestUploadUrlResponse,
} from "@workspace/api-zod";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";

const objectStorageService = new ObjectStorageService();

async function streamObject(
  res: Response,
  file: Awaited<ReturnType<ObjectStorageService["getObjectEntityFile"]>>,
  isPublic = false,
  downloadName?: string,
) {
  const response = await objectStorageService.downloadObject(file, { isPublic });
  res.status(response.status);
  response.headers.forEach((value, key) => res.setHeader(key, value));
  if (isPublic) {
    // Public objects are user-uploaded. Never let the browser sniff or render
    // stored bytes as an active document (HTML/SVG/XML), which would be
    // stored XSS on the app origin — only passive media types render inline.
    res.setHeader("X-Content-Type-Options", "nosniff");
    const contentType = String(res.getHeader("Content-Type") ?? "");
    const passive =
      /^(image|video|audio|font)\//i.test(contentType) &&
      !/svg/i.test(contentType);
    if (!passive && !downloadName) {
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Disposition", "attachment");
    }
  }
  if (downloadName) {
    const safe = downloadName.replace(/[^\w.-]/g, "_").slice(0, 120) || "download";
    res.setHeader("Content-Disposition", `attachment; filename="${safe}"`);
  }
  if (response.body) {
    const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
    nodeStream.pipe(res);
  } else {
    res.end();
  }
}

/**
 * Public storage routes. Mounted BEFORE authentication.
 * Only serves assets from PUBLIC_OBJECT_SEARCH_PATHS, which are intentionally public.
 */
export const publicStorageRouter: IRouter = Router();

publicStorageRouter.get(
  "/storage/public-objects/*filePath",
  async (req: Request, res: Response) => {
    try {
      const raw = req.params.filePath;
      const filePath = Array.isArray(raw) ? raw.join("/") : raw;
      const file = await objectStorageService.searchPublicObject(filePath);
      if (!file) {
        res.status(404).json({ error: "File not found" });
        return;
      }
      // Public assets (e.g. app branding) are embedded by other origins such
      // as the Expo mobile app. Helmet's default CORP of `same-origin` would
      // make browsers block those loads, so relax it for public objects only.
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      await streamObject(res, file, true);
    } catch (error) {
      req.log.error({ err: error }, "Error serving public object");
      res.status(500).json({ error: "Failed to serve public object" });
    }
  },
);

/**
 * Protected storage routes. Mounted AFTER requireTenant, so only authenticated
 * tenants can mint upload URLs or read private object entities. Private object
 * keys are unguessable, and access is restricted to signed-in users.
 */
export const protectedStorageRouter: IRouter = Router();

/**
 * POST /storage/uploads/request-url
 * Request a presigned URL for file upload. The client uploads the file directly
 * to the returned presigned URL.
 */
protectedStorageRouter.post(
  "/storage/uploads/request-url",
  async (req: Request, res: Response) => {
    const parsed = RequestUploadUrlBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Missing or invalid required fields" });
      return;
    }

    try {
      const { name, size, contentType } = parsed.data;
      const uploadURL =
        parsed.data.purpose === "brand-voice-sample"
          ? await objectStorageService.getBrandVoiceSampleUploadURL(req.tenantId)
          : await objectStorageService.getObjectEntityUploadURL(req.tenantId);
      const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);

      res.json(
        RequestUploadUrlResponse.parse({
          uploadURL,
          objectPath,
          metadata: { name, size, contentType },
        }),
      );
    } catch (error) {
      req.log.error({ err: error }, "Error generating upload URL");
      res.status(500).json({ error: "Failed to generate upload URL" });
    }
  },
);

/**
 * GET /storage/objects/*
 * Serve private object entities from PRIVATE_OBJECT_DIR to authenticated tenants.
 */
protectedStorageRouter.get(
  "/storage/objects/*path",
  async (req: Request, res: Response) => {
    try {
      const raw = req.params.path;
      const wildcardPath = Array.isArray(raw) ? raw.join("/") : raw;
      const objectPath = `/objects/${wildcardPath}`;
      const objectFile = await objectStorageService.getObjectEntityFile(
        objectPath,
        req.tenantId,
      );
      // ?download=<name> forces a save dialog instead of inline playback.
      const downloadParam = req.query.download;
      const downloadName =
        typeof downloadParam === "string" && downloadParam.length > 0
          ? downloadParam
          : undefined;
      await streamObject(res, objectFile, false, downloadName);
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        req.log.warn({ err: error }, "Object not found");
        res.status(404).json({ error: "Object not found" });
        return;
      }
      req.log.error({ err: error }, "Error serving object");
      res.status(500).json({ error: "Failed to serve object" });
    }
  },
);

export default publicStorageRouter;
