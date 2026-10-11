// Safe migration shell: do not expose D1, identities or health records.
// Authentication + WHOOP OAuth, per-user authorization and secrets handling
// must be ported and audited before activating routes.
export default {
  async fetch() {
    return new Response(JSON.stringify({
      error: "WHOOP Lens Cloudflare migration not activated",
      status: "maintenance"
    }), {
      status: 503,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff"
      }
    });
  }
};
