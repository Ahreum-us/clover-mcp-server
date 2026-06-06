import axios, { AxiosInstance, AxiosError } from "axios";
import axiosRetry from "axios-retry";
import Bottleneck from "bottleneck";

export interface CloverConfig {
  accessToken: string;
  merchantId: string;
  sandbox?: boolean;
}

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

    // Retry on transient errors and 429s with exponential backoff
    axiosRetry(this.http, {
      retries: 3,
      retryDelay: axiosRetry.exponentialDelay,
      retryCondition: (err) =>
        err.response?.status === 429 || axiosRetry.isNetworkOrIdempotentRequestError(err),
    });

    // Per-merchant rate limiter: max 5 concurrent, min 100ms between requests
    this.limiter = new Bottleneck({ maxConcurrent: 5, minTime: 100 });

    this.http.interceptors.response.use(undefined, (err: AxiosError) => {
      const status = err.response?.status;
      const data = err.response?.data as any;
      const msg = data?.message ?? data?.error ?? err.message ?? "unknown error";
      return Promise.reject(new Error(`Clover API ${status ?? "network"} error: ${msg}`));
    });
  }

  async get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    const res = await this.limiter.schedule(() => this.http.get<T>(path, { params }));
    return res.data;
  }

  async post<T>(path: string, data?: unknown): Promise<T> {
    const res = await this.limiter.schedule(() => this.http.post<T>(path, data));
    return res.data;
  }

  async put<T>(path: string, data?: unknown): Promise<T> {
    const res = await this.limiter.schedule(() => this.http.put<T>(path, data));
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
