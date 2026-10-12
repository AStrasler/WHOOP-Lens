# Already using WHOOP Lens?

Use this when WHOOP Lens is already connected and you want to know whether a newer server version is visible.

## Do I need to do anything?

If recovery, sleep, and profile questions still return your own dated WHOOP data, leave the WHOOP connection in place. Start a **new ChatGPT conversation** and ask:

`What can WHOOP Lens do now? Show the capability directory, and say whether Stress Monitor history is available.`

A working answer names real tools such as recovery, sleep, cycles, and workouts, and says that **WHOOP Stress Monitor zone history is not available** from the official API. It must not turn strain, heart rate, or HRV into high-stress hours.

Charts appear only when that ChatGPT app can draw them. A text summary is the expected fallback.

## How do I see a server update?

1. Open a new conversation in the same ChatGPT account that already has WHOOP Lens.
2. Ask the prompt above.
3. If the reply still lacks the capability directory, open the WHOOP Lens plugin settings and confirm the server URL is `https://evoiwauqplbcecumiwqn.supabase.co/functions/v1/whoop-mcp/mcp`.
4. Start another new conversation and ask again.

You do not need to delete the plugin when the server URL is already correct. A new conversation is the first refresh step.

## What if nothing changed?

| What you see | What to do |
| --- | --- |
| Older chat ignores the new prompt | Leave that chat. Open a new one and ask again. |
| Profile or recovery still matches your WHOOP app | The connection is working. Stop here. |
| The reply estimates stress hours from strain or heart rate | Ask it to call `get_capabilities` and to follow the Stress Monitor limitation. |
| Consent page says the app was previously approved, but WHOOP reads fail | That confirms the ChatGPT connection only. Open [WHOOP Lens setup](https://astrasler.github.io/WHOOP-Lens/), sign in, and use **Connect WHOOP**. |
| Setup says the public seats are full | A brand-new WHOOP connection cannot be stored. An existing connection can stay connected. |
| Page says the account is disabled | The maintainer has to re-enable that account. Reconnecting WHOOP will not bypass it. |

## Two different sign-ins

ChatGPT’s plugin login and WHOOP’s authorization are separate.

- **ChatGPT to WHOOP Lens:** the consent page at setup. **Previously approved** means this part succeeded.
- **WHOOP to WHOOP Lens:** **Connect WHOOP** on [the setup site](https://astrasler.github.io/WHOOP-Lens/). Finish on WHOOP’s own page.

Reconnect only the part that failed. A working WHOOP link does not need to be revoked to refresh ChatGPT.

## Android and files

No Android app is required. The optional companion does not upload readings while upload is disabled. The browser workspace can preview a supported file on this device only; that preview is not sent to WHOOP Lens.

## What not to send

Do not send passwords, access tokens, refresh tokens, or exported health files to support or into a GitHub issue. Compare readings privately with your WHOOP app.
