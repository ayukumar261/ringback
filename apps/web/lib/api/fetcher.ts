import { API_URL } from "./config"

// ApiError keeps the status for error UIs and SWR retry decisions.
export class ApiError extends Error {
  constructor(
    readonly status: number,
    path: string
  ) {
    super(`api request failed: ${status} ${path}`)
  }
}

// fetcher resolves SWR keys (api paths) against the api origin.
export async function fetcher<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`)
  if (!res.ok) throw new ApiError(res.status, path)
  return (await res.json()) as T
}
