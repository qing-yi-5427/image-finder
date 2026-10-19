import type { TypedImageFinderClient } from "../src/api.js";
import { cleanPayload } from "./model";
import { userError } from "../src/user-errors";
/** Optional form fields are omitted; the host still validates every raw IPC request. */
export const api: TypedImageFinderClient = {
  onAppEvent: (callback) => window.imageFinder.onAppEvent?.(callback) ?? (()=>{}),
  invoke: (method, payload) =>
    window.imageFinder
      .invoke(method, cleanPayload(payload) as typeof payload)
      .catch((error) => {
        throw new Error(userError(error));
      }),
  onProgress: (callback) => window.imageFinder.onProgress(callback),
};
