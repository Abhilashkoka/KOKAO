import { AsyncLocalStorage } from "node:async_hooks";

export interface VideoProviderTaskReceipt {
  taskId: string;
  requestId: string | null;
}

export interface VideoProviderTaskStore {
  load(
    operationKey: string,
    provider: string,
    model: string,
  ): Promise<VideoProviderTaskReceipt | null>;
  save(
    operationKey: string,
    provider: string,
    model: string,
    receipt: VideoProviderTaskReceipt,
  ): Promise<void>;
  markSubmitStarted?(operationKey: string, provider: string, model: string): Promise<void>;
  isSubmitUncertain?(operationKey: string, provider: string, model: string): Promise<boolean>;
}

const storage = new AsyncLocalStorage<VideoProviderTaskStore>();

export function currentVideoProviderTaskStore(): VideoProviderTaskStore | null {
  return storage.getStore() ?? null;
}

export function withVideoProviderTaskStore<T>(
  store: VideoProviderTaskStore,
  work: () => Promise<T>,
): Promise<T> {
  return storage.run(store, work);
}