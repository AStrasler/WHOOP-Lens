# Already using WHOOP Lens?

Use this when WHOOP Lens is already connected and you want to know whether a newer server version is visible.

## Do I need to do anything?

If recovery, sleep, and profile questions still return your own dated WHOOP data, leave that WHOOP connection in place. Start a **new ChatGPT conversation** and ask:

`What can WHOOP Lens do now? Show the capability directory, and say whether Stress Monitor history is available.`

A current answer names recovery, sleep, cycles, and workouts, and says that **WHOOP Stress Monitor zone history is not available** from the official API. It does not convert strain, heart rate, or HRV into high-stress hours. Charts appear only when that ChatGPT app can draw them.

## If the chat looks unchanged

1. Open a new conversation in the same ChatGPT account.
2. Ask the question above.
3. If the capability directory is still missing, confirm the connector's server URL is `https://whooplens.tech/mcp`.
4. Start another new conversation and ask again.

You do not need to delete the connector when that server URL is already correct.

## If you see this, do this

| What you see | What to do |
| --- | --- |
| An older chat ignores the new question | Leave it and open a new conversation. |
| Profile or recovery still matches the WHOOP app | The connection is working. |
| The reply estimates stress hours from strain or heart rate | Ask for `get_capabilities` and the Stress Monitor limitation. |
| ChatGPT is connected, but WHOOP reads fail | Ask ChatGPT to run `connect_whoop`, open the WHOOP authorization link it returns, and approve on WHOOP's page. |
| All seats are in use | A new WHOOP connection cannot be stored. An existing connection can always reconnect. |
| Your WHOOP Lens membership is not active | Sign-in is refused, and reconnecting WHOOP does not re-enable it. |

## Two different sign-ins

The ChatGPT connection uses a Cloudflare Access email one-time PIN at https://auth.whooplens.tech and the consent page there. Connecting WHOOP is a separate WHOOP authorization started with `connect_whoop`. Reconnect only the part that failed.

No Android app is required. A browser file preview stays on this device.

## What not to send

Do not send passwords, access tokens, refresh tokens, or exported health files to support or into a GitHub issue. Compare readings privately with your WHOOP app.
