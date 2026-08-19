/** Plain data for the `GET /health` response — pure so it's unit-testable without a running server. */
export interface HealthResponse {
  status: 'ok';
  timestamp: number;
}

export function buildHealthResponse(now: () => number = Date.now): HealthResponse {
  return { status: 'ok', timestamp: now() };
}
