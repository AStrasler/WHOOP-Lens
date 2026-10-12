# WHOOP Lens: refreshing or reconnecting after an update

> **DRAFT. NOT YET VERIFIED.** Issue #7 requires these steps to be checked by hand
> in the current ChatGPT web and Android apps after the next approved deploy.
> Every step marked **[VERIFY UI]** names a ChatGPT menu or button that has not
> been confirmed yet. Do not send this guide to beta testers until those marks are removed
> and dated screenshots are added.

## 1. Do I need to do anything?

Usually not. WHOOP Lens runs on a server. When it gets new features, your existing
connection keeps working and ChatGPT picks up the new tools on its own.
**[VERIFY: confirm after the deploy whether new tools appear in an existing conversation, only in a new one, or only after a refresh.]**

You only need to act if:
- the new features don't show up (section 3), or
- ChatGPT says WHOOP Lens needs to be connected or authorized again (section 4).

You do **not** need to delete and reinstall WHOOP Lens, and you should not
disconnect a WHOOP account that is working.

## 2. How do I see the new features and check that they work?

1. Start a **new** ChatGPT conversation.
2. Paste this message:

   ```
   @Whoop Lens What can you do now? Show me the capability directory and a sample chart from my own recent data if available.
   ```
3. A working connection answers with the capability directory and a small example
   from **your own** recent WHOOP data, with dates. Whether a chart appears depends
   on the ChatGPT app you're using; a table or text answer is also fine.
4. Check that the data belongs to you (recent dates, your usual numbers).

## 3. Path A: connected, but new features are missing

1. Open a new conversation and try the message from section 2 again.
2. Refresh the WHOOP Lens tools: **[VERIFY UI: web: Settings → Apps/Connectors → WHOOP Lens → refresh?]**
   **[VERIFY UI: Android: profile menu → Apps/Connectors → WHOOP Lens?]**
3. Try the message again. ChatGPT may keep an older tool list for a while.
   **[VERIFY: how long, and whether signing out and back in clears it.]**
4. **Stop here** and contact the operator if it still looks old. They can check
   which version is deployed (`get_capabilities` reports the catalog version).

## 4. Path B: authorization actually failed

There are two separate links. Fix only the one that's broken.

| What you see | Which link | What to do |
|---|---|---|
| ChatGPT asks you to connect or sign in to WHOOP Lens, or says "Authorization unavailable" | **ChatGPT ↔ WHOOP Lens** | Reconnect WHOOP Lens in ChatGPT **[VERIFY UI: exact menu path, web and Android]**, sign in with your invited WHOOP Lens account, and approve. Your WHOOP connection is kept. |
| WHOOP Lens answers but says your WHOOP account isn't connected or the WHOOP connection expired | **WHOOP ↔ WHOOP Lens** | Open the WHOOP Lens setup page at https://astrasler.github.io/WHOOP-Lens/, sign in, and choose **Connect WHOOP**. You don't need to touch the ChatGPT connection. |
| "This account is disabled" or "membership required" | **Invite** | Access is invite-only. Contact the operator; reconnecting won't help. |

**Stop conditions:** if one attempt at the matching fix doesn't work, stop and
contact the operator. Repeated disconnects can use up your WHOOP authorization.

## 5. Android Health Connect companion (optional)

The Android companion is optional and hasn't been released. Ordinary WHOOP Lens
use needs nothing installed. **[VERIFY: update this section if a private APK is distributed.]**

## Verification log (fill in before release)

| Date | Platform | App version | Section | Result | Screenshot |
|---|---|---|---|---|---|
| | ChatGPT web | | 1–4 | not yet verified | |
| | ChatGPT Android | | 1–4 | not yet verified | |
