// Retired staging entry point. Production MCP uses the independent OAuth resource Worker.
// This disabled Worker must never authenticate against the retired identity provider.
import { createStagingRouter } from "./router.mjs";

export default {
  fetch: createStagingRouter()
};
