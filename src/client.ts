import {
  type ClientOptions,
  type RequestOptions,
  type ResolvedConfig,
  request,
  resolveConfig,
} from "./http.ts";

export class DevToClient {
  private readonly config: ResolvedConfig;

  constructor(options: ClientOptions = {}) {
    this.config = resolveConfig(options);
  }

  /** Escape hatch and internal transport — namespace methods route through here. */
  request<T>(method: string, path: string, opts?: RequestOptions): Promise<T> {
    return request<T>(this.config, method, path, opts);
  }
}
