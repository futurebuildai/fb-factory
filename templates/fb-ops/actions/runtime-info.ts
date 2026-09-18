import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

/** Read-only self-report: which app build is running and for how long. */
export default defineAction({
  description:
    "Report this FB Ops app's runtime facts: app id, Node version, process uptime. Read-only.",
  readOnly: true,
  http: { method: "GET" },
  mcpTool: true,
  schema: z.object({}).strict(),
  run: async () => ({
    app: "fb-ops",
    node: process.version,
    uptimeSeconds: Math.round(process.uptime()),
    pid: process.pid,
  }),
});
