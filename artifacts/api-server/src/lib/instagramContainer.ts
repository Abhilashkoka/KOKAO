import { platformFetch, PlatformTimeoutError } from "./platformFetch";

/** Creating a container does NOT publish a post. A lost create response may
 * leave an unpublished container, so this preparation step is safe to retry.
 * Never apply this policy to media_publish: that write can already have landed.
 * This runs in the Instagram background job, not the 10s synchronous drain.
 */
export async function createInstagramContainer(url: string, body: URLSearchParams) {
  try {
    return await platformFetch(url, { method: "POST", body }, 30_000);
  } catch (error) {
    if (error instanceof PlatformTimeoutError) {
      // The publish retry loop treats ordinary transport errors as transient.
      // Do not preserve PlatformTimeoutError's fail-fast classification here.
      throw new Error("Instagram timed out while preparing the image after 30s. No publish request was sent.", { cause: error });
    }
    throw error;
  }
}