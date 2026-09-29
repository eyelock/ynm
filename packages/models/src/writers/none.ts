import { ModelUnavailableError, type WriteRequest, type Writer, type Written } from "../types.js";

/** The explicit "no generation" writer: passes that need one fall back to their non-generative path. */
export class NoneWriter implements Writer {
  readonly name = "none";
  async write<T>(_req: WriteRequest<T>): Promise<Written<T>> {
    throw new ModelUnavailableError("writer", "none configured (set dream.writer)");
  }
}
