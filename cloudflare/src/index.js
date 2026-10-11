// WHOOP Lens migration Worker. Supabase stays primary, and this service remains
// disabled until owner-reviewed release gates are satisfied.
import {verifySupabaseSession} from "./identity.mjs";
import { createStagingRouter } from "./router.mjs";

export default {
  fetch: createStagingRouter({verifyIdentity:verifySupabaseSession})
};
