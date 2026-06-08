import axios, { AxiosInstance, AxiosError } from "axios";
import axiosRetry from "axios-retry";
import Bottleneck from "bottleneck";
import { CloverApiError } from "./errors.js";

export interface CloverConfig {
  accessToken: string;
  merchantId: string;
  sandbox?: boolean;
}

const GETALL_MAX_PAGES = 10_000;

function serializeParams(params: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, val] of Object.entries(params)) {
    if (val === undefined || val === null) continue;
    if (Array.isArray(val)) {
      for (const v of val) parts.push(`${key}=${encodeURIComponent(String(v))}`);
    } else {
      parts.push(`${key}=${encodeURIComponent(String(val))}`);
    }
  }
  return parts.join("&");
}

export class CloverClient {
  private http: AxiosInstance;
  private limiter: Bottleneck;
  readonly merchantId: string;

  constructor(config: CloverConfig) {
    this.merchantId = config.merchantId;
    const base = config.sandbox
      ? "https://apisandbox.dev.clover.com"
      : "https://api.clover.com";

    this.http = axios.create({
      baseURL: base,
      timeout: 15000,
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        "Content-Type": "application/json",
      },
      paramsSerializer: serializeParams,
    });

    axiosRetry(this.http, {
      retries: 3,
      retryDelay: axiosRetry.exponentialDelay,
      retryCondition: (err) =>
        err.response?.status === 429 ||
        axiosRetry.isNetworkOrIdempotentRequestError(err),
    });

    this.limiter = new Bottleneck({ maxConcurrent: 5, minTime: 100 });

    this.http.interceptors.response.use(undefined, (err: AxiosError) => {
      const status = err.response?.status ?? null;
      const body = err.response?.data;
      const data = body as any;
      const message =
        data?.message ??
        data?.error ??
        data?.errors?.[0]?.message ??
        err.message ??
        "unknown error";
      const code = data?.code ?? null;
      const requestPath = err.config?.url ?? null;
      const requestMethod = err.config?.method?.toUpperCase() ?? null;

      return Promise.reject(
        new CloverApiError({
          message: String(message),
          status,
          code,
          body,
          requestPath,
          requestMethod,
        })
      );
    });
  }

  async get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    const res = await this.limiter.schedule(() =>
      this.http.get<T>(path, { params })
    );
    return res.data;
  }

  async getAll<T = any>(
    path: string,
    params: Record<string, unknown> = {}
  ): Promise<T[]> {
    const all: T[] = [];
    const limit = Number(params.limit || 100);
    let offset = 0;
    let hasMore = true;
    let pages = 0;

    while (hasMore) {
      if (pages++ >= GETALL_MAX_PAGES) {
        throw new CloverApiError({
          message:
            `getAll exceeded ${GETALL_MAX_PAGES} pages on ${path}. ` +
            `Either narrow your filter or use paginated get() directly.`,
          status: null,
          requestPath: path,
          requestMethod: "GET",
        });
      }

      const data = await this.get<any>(path, { ...params, limit, offset });
      const elements = data.elements || [];
      all.push(...elements);

      if (elements.length < limit) {
        hasMore = false;
      } else {
        offset += limit;
      }
    }
    return all;
  }

  async post<T>(path: string, data?: unknown): Promise<T> {
    const res = await this.limiter.schedule(() =>
      this.http.post<T>(path, data)
    );
    return res.data;
  }

  async put<T>(path: string, data?: unknown): Promise<T> {
    const res = await this.limiter.schedule(() =>
      this.http.put<T>(path, data)
    );
    return res.data;
  }

  async delete<T>(path: string): Promise<T> {
    const res = await this.limiter.schedule(() => this.http.delete<T>(path));
    return res.data;
  }

  v3(endpoint: string) {
    return `/v3/merchants/${this.merchantId}${endpoint}`;
  }
}
