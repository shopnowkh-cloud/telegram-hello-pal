import { createFileRoute } from "@tanstack/react-router";
import { runWatchdog } from "@/lib/telegram/handler";

/**
 * Payment watchdog endpoint. Called by pg_cron once a minute (and reachable
 * for manual triggering). Authenticates via Supabase anon key in the `apikey`
 * header, matching the canonical pg_cron pattern.
 */
export const Route = createFileRoute("/api/public/telegram/watchdog")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env.SUPABASE_PUBLISHABLE_KEY;
        const got = request.headers.get("apikey") ?? "";
        if (!expected || got !== expected) {
          return new Response("Unauthorized", { status: 401 });
        }
        try {
          const result = await runWatchdog();
          return Response.json({ ok: true, ...result });
        } catch (e) {
          console.error("[watchdog] error:", e);
          return Response.json({ ok: false, error: (e as Error).message }, { status: 500 });
        }
      },
    },
  },
});
