/**
 * Canvas API client — handles auth, pagination via Link headers, and error mapping.
 */

import axios, { AxiosInstance, AxiosError } from "axios";

export interface CanvasConfig {
  baseUrl: string;  // e.g. https://boisestateuniversity.instructure.com
  apiToken: string;
}

export interface PaginatedResult<T> {
  items: T[];
  hasMore: boolean;
  nextUrl: string | undefined;
}

export class CanvasClient {
  private http: AxiosInstance;

  constructor(config: CanvasConfig) {
    this.http = axios.create({
      baseURL: `${config.baseUrl}/api/v1`,
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        Accept: "application/json",
      },
      timeout: 30000,
    });
  }

  /** Single-object GET (e.g. file metadata, single submission). */
  async get<T>(endpoint: string, params?: Record<string, unknown>): Promise<T> {
    const res = await this.http.get<T>(endpoint, { params });
    return res.data;
  }

  /**
   * List GET with Canvas Link-header pagination.
   * Returns the current page's items plus a flag/URL for the next page.
   */
  async getPaginated<T>(
    endpoint: string,
    params?: Record<string, unknown>
  ): Promise<PaginatedResult<T>> {
    const res = await this.http.get<T[]>(endpoint, { params });
    const link = (res.headers["link"] as string) ?? "";
    const nextMatch = link.match(/<([^>]+)>;\s*rel="next"/);
    const nextUrl = nextMatch ? nextMatch[1] : undefined;
    return { items: res.data, hasMore: !!nextUrl, nextUrl };
  }

  /**
   * Fetch a URL directly (used for next-page URLs returned by Canvas
   * which are fully-qualified, not relative to baseURL).
   */
  async getUrl<T>(url: string): Promise<PaginatedResult<T>> {
    const res = await axios.get<T[]>(url, {
      headers: {
        Authorization: this.http.defaults.headers.common["Authorization"],
        Accept: "application/json",
      },
      timeout: 30000,
    });
    const link = (res.headers["link"] as string) ?? "";
    const nextMatch = link.match(/<([^>]+)>;\s*rel="next"/);
    const nextUrl = nextMatch ? nextMatch[1] : undefined;
    return { items: res.data, hasMore: !!nextUrl, nextUrl };
  }
}

/** Map Axios errors to human-readable strings that guide the agent. */
export function handleApiError(error: unknown): string {
  if (error instanceof AxiosError) {
    if (error.response) {
      const status = error.response.status;
      const msg = (error.response.data as { message?: string })?.message;
      if (status === 401)
        return "Error: Unauthorized — check your CANVAS_API_TOKEN environment variable.";
      if (status === 403)
        return "Error: Forbidden — you don't have access to this resource.";
      if (status === 404)
        return "Error: Not found — check the course_id or assignment_id value.";
      if (status === 429)
        return "Error: Rate limited by Canvas. Wait a moment and retry.";
      return `Error: Canvas returned HTTP ${status}${msg ? `: ${msg}` : ""}.`;
    }
    if (error.code === "ECONNABORTED")
      return "Error: Request timed out. Canvas may be slow — try again.";
    if (error.code === "ENOTFOUND")
      return "Error: Cannot reach Canvas. Verify your CANVAS_BASE_URL setting.";
  }
  return `Error: ${error instanceof Error ? error.message : String(error)}`;
}
