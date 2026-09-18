import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

/**
 * Read-only platform probe: is each FB Console environment answering? A guest
 * call to /v1/health that returns the 401 scope JSON is the documented healthy
 * signal for the console API, so only transport failures are unhealthy.
 */
export default defineAction({
  description:
    "Check FB Console API health for production and staging. Read-only.",
  readOnly: true,
  http: { method: "GET" },
  mcpTool: true,
  schema: z.object({}).strict(),
  run: async () => {
    const environments = [
      { name: "production", url: "https://api.futurebuild.ai/v1/health" },
      {
        name: "staging",
        url: "https://api-staging.futurebuild.ai/v1/health",
      },
    ];

    const results = await Promise.all(
      environments.map(async (env) => {
        try {
          const response = await fetch(env.url, {
            headers: { "X-Appwrite-Project": "console" },
            signal: AbortSignal.timeout(8000),
          });
          const body = await response.text();
          const healthy =
            response.status === 200 || response.status === 401 || response.status === 403;
          let detail = `HTTP ${response.status}`;
          if (response.status === 401 || response.status === 403) {
            detail = "answering (guest scope response)";
          } else if (!healthy) {
            detail = body.slice(0, 120);
          }
          return {
            name: env.name,
            url: env.url,
            status: response.status,
            healthy,
            detail,
          };
        } catch (error) {
          return {
            name: env.name,
            url: env.url,
            status: "error" as const,
            healthy: false,
            detail: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );

    const allHealthy = results.every((r) => r.healthy);
    return {
      healthy: allHealthy,
      environments: results,
      checkedAt: new Date().toISOString(),
      summary: allHealthy
        ? "All FB Console environments are answering."
        : "At least one FB Console environment is unreachable.",
    };
  },
});
