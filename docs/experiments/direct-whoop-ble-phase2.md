# WHOOP Lens Phase 2: Independent WHOOP Hardware Integration

> **PARKED FOR CODEX. DO NOT START UNTIL THE CURRENT ANDROID DESIGN IMPLEMENTATION IS FINISHED AND VERIFIED.**
>
> This PR stores the complete future engineering prompt. It does not authorize deployment, merging, cloud uploads, or changes to production infrastructure.

## Objective
Add an **optional direct Bluetooth mode** for compatible WHOOP hardware alongside the existing official WHOOP API integration. Prefer local-first collection and processing without requiring WHOOP cloud or a subscription for independently supported features. Preserve Claude's Android design and all existing functionality. Reuse established implementations where their licenses permit; learn from protocol research elsewhere rather than reinventing known details.

## Upstream research targets
1. **NOOP**: https://github.com/muftiarfan/noop — Android BLE, device discovery/authentication, sensor acquisition, local calculations, offline storage, device compatibility.
2. **Wearable**: https://github.com/johnmiddleton12/wearable — BLE protocol, historical collection, synchronization patterns, connection lifecycle and recovery.
3. **Goose**: https://github.com/b-nnett/goose — WHOOP 5.0 protocol, packet structures, decoding and compatibility gaps.
4. **whoop4-ble**: https://github.com/andyguzmaneth/whoop4-ble — WHOOP 4.0 HR, R-R intervals, motion, BLE services; verify MIT notices.

Inspect current repository files, README, dependencies, commits, upstream attribution, licenses, and device claims. Do not assume all advertised functions work.

## Licensing and provenance
- Determine the **actual** license and reuse terms for each component, including source-file headers, dependencies and upstream material.
- Preserve required copyright and license notices; record original repository URL, commit, author, modified files, and changes in a third-party attribution inventory.
- Distinguish directly reusable code from protocol facts/research for independent implementation.
- Public visibility, downloads, and attribution alone do not establish redistribution permission for unlicensed source. Do not incorporate code without a suitable grant; keep useful protocol research in scope.
- Keep this audit practical for a small hobbyist project.

## First inspect WHOOP Lens
Audit current Android dashboards, navigation, design system, Health Connect readers, WorkManager, encrypted cache, widgets, OAuth/WHOOP API, source labels, tests, and security. Identify provider interfaces and the minimum changes required. **Do not rewrite or replace existing pipelines.**

## Proposed architecture
- **Official WHOOP API mode:** preserve existing authenticated WHOOP measurements and WHOOP source-of-truth status.
- **Independent BLE mode:** optional direct connection to compatible devices, with local processing and encrypted storage.
- Source-aware data models must distinguish official WHOOP, direct BLE raw observations, independently computed estimates, and Health Connect.
- Prefer `WHOOP hardware -> Android BLE provider -> local storage/calculation -> existing dashboard/widgets`.
- Cloud synchronization is optional future work and **remains OFF**. No backend upload of raw wearable data without separate approval.

## Investigation and implementation tasks
1. Compare WHOOP 4.0, 5.0 and MG separately; mark hardware-tested, upstream-claimed, experimental and unsupported functions.
2. Evaluate BLE scanning, discovery, pairing/authentication, services/characteristics, packet decoding, sensor subscriptions, historical reads, reconnection, background collection within Android limits, battery use, permissions and account isolation.
3. Prototype the **smallest viable direct sensor read** on one supported device generation. Use mocks/fixtures when no device is available, and never claim mocked results as physical-device validation.
4. Integrate only verified capabilities into local storage and existing dashboards, keeping independent metrics labeled distinctly.
5. Investigate local HR, R-R intervals, HRV, resting HR, activity, sleep, recovery and strain estimates only to the extent supported by actual sensor data. Never invent readings or equate custom estimates with WHOOP proprietary scores.
6. Extend existing Claude-designed UI minimally for device setup, source selection, connection status, compatibility, history, permission and background collection settings.
7. Test protocol decoders, BLE lifecycle, disconnects, permission revocation, offline behavior, timestamps, duplicates, missing data, battery constraints, account isolation and regression against official API/Health Connect.

## Sequence
**Stage A:** Repository, licensing, provenance and compatibility audit.

**Stage B:** Component reuse decision and architecture mapped to the existing app.

**Stage C:** Isolated local BLE prototype with clear evidence of what actually works.

**Stage D:** Source-aware Android integration, only after review of A–C.

**Stage E:** Tests, findings, limitations and next-step recommendations.

## Restrictions
- Do not begin until current Android design implementation is finished and verified.
- Keep this PR **draft and unmerged**. No production deployment, push of unrelated work, or release.
- Do not enable cloud uploads, change production OAuth/Cloudflare, disable security, flash firmware or bypass device security.
- Keep the official WHOOP API integration intact.
- Do not claim device compatibility without evidence.
- Ask for owner approval before any production changes or activating uploads.

## Codex deliverables
- Four-repository comparison, license/provenance inventory and attribution notices.
- Device generation compatibility matrix with evidence levels.
- Exact components recommended for reuse vs independent implementation.
- Proposed interfaces, data flow and minimal integration plan.
- Local prototype and test results where feasible.
- Known limitations, unresolved permissions and hardware requirements.
- Specific owner approvals needed next.

**Engineering principle:** Save work by building on verified prior research and properly reusable code, not by importing four entire applications. Keep this hobbyist-scale.

**Codex: When the Android design PR is completed and verified, use this document as the full Phase 2 assignment. Start with Stage A and report findings before substantial implementation.**