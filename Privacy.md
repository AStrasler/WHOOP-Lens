# WHOOP Lens — Privacy Statement

Last updated: October 4, 2026

WHOOP Lens is a hosted plugin that lets a person connect their own WHOOP account so ChatGPT and Codex can read that person's data with their permission. Each person signs in with their own Supabase user. The project is operated by Aaron Strasler. It is not affiliated with WHOOP.

## Data accessed and purpose

With your authorization, the plugin reads WHOOP recovery, sleep, physiological cycles and strain, workouts, profile information, and body measurements. The WHOOP connection requests read scopes only (`read:profile`, `read:body_measurement`, `read:recovery`, `read:sleep`, `read:workout`, and `read:cycles`), plus `offline` so access can be refreshed.

If Samsung Health records have been uploaded for your Supabase user, the plugin can also read those stored records, such as sleep, heart rate, blood oxygen, steps, activity, exercise, body composition, skin temperature, energy score, blood pressure, and profile. Samsung Health records are kept separate from WHOOP data.

This information is used to answer your questions and produce the summaries you request in ChatGPT or Codex.

## Processing and sharing

The GitHub Pages site is the sign-in and consent screen. Supabase Auth handles that sign-in. The Supabase edge function `whoop-mcp` exchanges and refreshes WHOOP tokens, calls the WHOOP API, and reads Samsung Health records stored for your user. That processing runs on Supabase, not only on your computer.

Data returned to ChatGPT or Codex is processed by OpenAI under your OpenAI account settings and the OpenAI privacy policy: https://openai.com/policies/privacy-policy/.

WHOOP data and Samsung Health records are not sold and are not used for advertising. This privacy statement is published at https://astrasler.github.io/WHOOP-Lens/privacy/. WHOOP records, Samsung Health records, credentials, and access tokens are not published in the git repository.

## Credentials, retention, and revocation

WHOOP access and refresh tokens are encrypted per Supabase user and stored in Supabase so the plugin can read WHOOP and refresh authorization. They are not stored only on your computer. The Pages app does not put your Supabase session in browser storage.

You can revoke the plugin in your WHOOP account settings. Revocation stops future authorized WHOOP access. It does not automatically delete information already included in ChatGPT or Codex conversations. Conversations remain subject to your OpenAI settings and controls.

Sign out of the Pages app to end the in-memory Supabase session. Disabling a Supabase user through the optional `whoop_members` kill switch stops that user from calling the plugin.

WHOOP Lens has 9 public connection seats and 1 developer seat. A person who does not already have a WHOOP connection cannot complete a new one once the public seats are full. The developer seat is one Supabase user chosen outside this repository. When a public seat is unavailable, the plugin can store a waitlist intake for that signed-in user: the Supabase user id, the account email when it matches a normal address, the time, and the notice destination whoop-lens@outlook.com. That intake does not include WHOOP access tokens, refresh tokens, client secrets, authorization codes, or health data. Storing the intake does not send mail.

## Contact

For privacy questions, contact Aaron Strasler at the contact email specified in the WHOOP developer application.

## Changes

This statement will be updated if the plugin's data handling changes.
