# Safe Cloudflare Worker settings updates

Never send a partial `bindings` array to the Worker settings endpoint. Cloudflare replaces the binding collection, even when the request is PATCH.

For rate-limit adjustments use `scripts/safe-worker-rate-limit.mjs`. It reads the complete live binding collection, modifies only the requested plain-text values, preserves all other binding objects (including secret references), checks the live deployment version before writing, and verifies the resulting configuration.

Requires `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` environment variables. Example:

```sh
node scripts/safe-worker-rate-limit.mjs --member 25 --developer 25 --apply
```

Without `--apply` it previews only. The script deliberately fails if the production deployment changes during preparation, if required infrastructure bindings are absent, or if the post-update binding set differs from the expected result. Do not log secrets or full binding payloads.
