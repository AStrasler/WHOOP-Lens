# WHOOP Lens — Privacy Statement

Last updated: October 11, 2026 (draft for the private beta; optional features are marked)

WHOOP Lens is a hosted plugin that lets a person connect their own WHOOP account so ChatGPT and Codex can read that person's data with their permission. Each person signs in with their own Supabase user. The project is operated by Aaron Strasler. It is not affiliated with WHOOP.

## Data accessed and purpose

With your authorization, the plugin reads WHOOP recovery, sleep, physiological cycles and strain, workouts, profile information, and body measurements. The WHOOP connection requests read scopes only (`read:profile`, `read:body_measurement`, `read:recovery`, `read:sleep`, `read:workout`, and `read:cycles`), plus `offline` so access can be refreshed.

If Samsung Health records have been uploaded for your Supabase user, the plugin can also read those stored records, such as sleep, heart rate, blood oxygen, steps, activity, exercise, body composition, skin temperature, energy score, blood pressure, and profile. Samsung Health records are kept separate from WHOOP data.

This information is used to answer your questions and produce the summaries you request in ChatGPT or Codex.

## Health Connect measurements (when enabled)

When this optional feature is enabled for the private beta, you can choose to send Android Health Connect measurements (daily steps, sleep sessions, heart rate and exercise sessions) to your own WHOOP Lens account. Records are stored in a separate table tied to your Supabase user, labelled with their source app where Android reports one, and are readable only by your account. Nothing is collected in the background: data is sent only when you deliberately sync or upload it.

## Private medical context (optional, when enabled)

You can choose to save private medical context, such as a condition, medication, allergy, or a note or question for a clinician. Each entry is typed or reviewed by you and saved only after you confirm it. Entries are labelled as self-reported or from a provider document, are stored in a separate table tied to your Supabase user, and are visible only to your account. ChatGPT and Codex can read your saved entries through WHOOP Lens but cannot create, change, or delete them. Original documents are not stored: a FHIR R4 file you pick in the web workspace is previewed in your browser, and only the entries you review and save are sent. Medical context is not shared with other WHOOP Lens users, including family members, and it is not combined with anyone else's records.

## Health information is context, not advice

WHOOP Lens can help you organize questions, summarize your own data, and point to published research. That is general, contextual information. It is not a diagnosis, treatment plan, or personal clinical advice, and it does not replace your clinician.

## Processing and sharing

The GitHub Pages site is the sign-in and consent screen. Supabase Auth handles that sign-in. The Supabase edge function `whoop-mcp` exchanges and refreshes WHOOP tokens, calls the WHOOP API, and reads Samsung Health records stored for your user. That processing runs on Supabase, not only on your computer.

Data returned to ChatGPT or Codex is processed by OpenAI under your OpenAI account settings and the OpenAI privacy policy: https://openai.com/policies/privacy-policy/.

WHOOP data and Samsung Health records are not sold and are not used for advertising. This privacy statement is published at https://astrasler.github.io/WHOOP-Lens/privacy/. WHOOP records, Samsung Health records, credentials, and access tokens are not published in the git repository.

## Credentials, retention, and revocation

WHOOP access and refresh tokens are encrypted per Supabase user and stored in Supabase so the plugin can read WHOOP and refresh authorization. They are not stored only on your computer. The Pages app does not put your Supabase session in browser storage.

You can revoke the plugin in your WHOOP account settings. Revocation stops future authorized WHOOP access. It does not automatically delete information already included in ChatGPT or Codex conversations. Conversations remain subject to your OpenAI settings and controls.

Sign out of the Pages app to end the in-memory Supabase session. Access is invite-only: a Supabase user must have an active `whoop_members` approval to use the plugin, the web workspace, or any upload. A user with no approval, or whose approval is switched off, is refused.

WHOOP Lens has 9 public connection seats and 1 developer seat. A person who does not already have a WHOOP connection cannot complete a new one once the public seats are full. The developer seat is one Supabase user chosen outside this repository. When a public seat is unavailable, the plugin can store a waitlist intake for that signed-in user: the Supabase user id, the account email when it matches a normal address, the time, and the notice destination whoop-lens@outlook.com. That intake does not include WHOOP access tokens, refresh tokens, client secrets, authorization codes, or health data. Storing the intake does not send mail.

## Deleting optional data

You can delete any saved medical context entry yourself in the web workspace at any time; deletion removes it from WHOOP Lens storage. To delete Health Connect measurements or your whole account, contact the operator below. Deleting your Supabase user deletes your stored WHOOP Lens records with it. Information already returned in a ChatGPT or Codex conversation stays subject to your OpenAI settings.

## Contact

For privacy questions, contact Aaron Strasler at the contact email specified in the WHOOP developer application.

## Changes

This statement will be updated if the plugin's data handling changes.
