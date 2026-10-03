# Codex WHOOP

Personal integration that connects a WHOOP account so ChatGPT and Codex can read WHOOP data with the owner's permission.

This is an independent personal project. It is not affiliated with WHOOP.

## What it does

The `docs/` directory is a small web UI for signing in (via Supabase), connecting WHOOP, and approving or denying app access. After setup, it shows a remote MCP address for use with ChatGPT or Codex.

Access is read-only for profile, body measurements, recovery, sleep, cycles, and workouts. See [Privacy.md](Privacy.md) for how data is handled.

## How to run

Serve or open the files under `docs/` (for example via GitHub Pages). The page talks to Supabase for auth and WHOOP connection flow; credentials and tokens are not meant to live in this repo.
