# WHOOP Lens capabilities and limitations

WHOOP Lens serves this catalog through the `get_capabilities` MCP tool. The deployed catalog is the runtime source of truth. A GitHub branch may be ahead of the currently deployed version.

The private connector is `https://whooplens.tech/mcp`. It has no stored WHOOP connection, so WHOOP measurement tools on that server do not return measurements yet. The existing Supabase connector remains the working WHOOP data path.

## Ask WHOOP Lens

Try: "What can you do?", "What patterns could I explore?", "What are your limitations?"

## Availability

`available` = supported by the deployed MCP or its host instructions but real records/host capabilities may still be missing. `requires_connection_or_data` = permission or source needed. `planned` = not deployed. `unsupported` = unavailable.

## Global limitations

- Measurements and patterns are not diagnoses or proofs of causation.

- No record is never proof of no symptoms or activity.

- Only current authorized account data may be read.

- Charts and research depend on the connected AI client.

- No automatic WHOOP setting changes or healthcare provider contact.

- Android Health Connect and medical-context integrations are planned, not live.

- The official WHOOP developer API does not provide Stress Monitor zone durations. Do not infer them from strain, heart rate, or HRV.

## Feature directory

### WHOOP profile (available)

WHOOP profile

**Needs:** Connected WHOOP account and relevant data

**Limits:** Snapshot only; values may be missing. Measurements do not establish medical diagnoses or causality.

**Try:** Show my WHOOP profile.

### Body measurements (available)

Body measurements

**Needs:** Connected WHOOP account and relevant data

**Limits:** Static measurements are not trends. Measurements do not establish medical diagnoses or causality.

**Try:** Show my WHOOP body measurements.

### Recovery, HRV and resting HR (available)

Recovery, HRV and resting HR

**Needs:** Connected WHOOP account and relevant data

**Limits:** Missing/unscored days; not a diagnosis. Measurements do not establish medical diagnoses or causality.

**Try:** Chart my recovery this week.

### Sleep and consistency (available)

Sleep and consistency

**Needs:** Connected WHOOP account and relevant data

**Limits:** Nap and time zone coverage may vary. Measurements do not establish medical diagnoses or causality.

**Try:** Explore my sleep stages and consistency.

### Daily cycles and strain (available)

Daily cycles and strain

**Needs:** Connected WHOOP account and relevant data

**Limits:** Open cycles are incomplete. Measurements do not establish medical diagnoses or causality.

**Try:** Compare my strain and recovery.

### Workouts and activity (available)

Workouts and activity

**Needs:** Connected WHOOP account and relevant data

**Limits:** Missing workouts do not imply inactivity. Measurements do not establish medical diagnoses or causality.

**Try:** Show my recent workouts and strain.

### Samsung Health uploads (available)

Samsung Health uploads

**Needs:** Prior authorized Samsung Health uploads

**Limits:** Only separately uploaded Samsung SDK records; no live phone sync. Measurements do not establish medical diagnoses or causality.

**Try:** What Samsung records were uploaded?

### Discover capabilities (available)

Discover capabilities

**Needs:** Signed-in WHOOP Lens account

**Limits:** A feature list does not imply this user has records. Measurements do not establish medical diagnoses or causality.

**Try:** What can WHOOP Lens do?

### Explore possible cross-metric patterns (available)

Compare dated sleep, recovery and cycle metrics when available.

**Needs:** Overlapping authorized dated WHOOP measurements

**Limits:** Correlations do not prove a cause. Too few aligned days can prevent meaningful comparisons.

**Try:** What patterns might I not know to ask about?

### Optional in-chat charts (available)

Charts when the connected AI client supports them; text otherwise.

**Needs:** Relevant records; Client-side chart support

**Limits:** The MCP cannot force the host to render a chart. A user can opt out of visuals.

**Try:** Chart my sleep and recovery. | Skip charts.

### Healthcare self-advocacy questions (available)

Help users express their own medical questions and concerns.

**Needs:** The user's own questions and context

**Limits:** No diagnosis or judgment that a provider is wrong. No unsolicited clinician contact or advice to change treatment.

**Try:** Help me ask about an unresolved concern.

### Provider-ready appointment brief (available)

Prepare a user-reviewed, copyable summary for appointments.

**Needs:** User-provided notes; optionally connected WHOOP measurements

**Limits:** No automatic provider messaging. No direct Epic, MyChart or Oracle Health integration.

**Try:** Make an appointment brief in my own words.

### Explain medical research (available)

Explain evidence where the AI host can retrieve verifiable sources.

**Needs:** User question; Host research access to verify citations

**Limits:** MCP does not browse medical literature. Never invent studies, diagnoses or causal conclusions.

**Try:** Explain this clinical term and cite studies you can verify.

### Health Connect phone sync (planned)

Private Android Health Connect imports.

**Needs:** Future Android companion and permissions

**Limits:** Not yet implemented.



### Private medical context (planned)

Optional patient-reviewed imported medical details.

**Needs:** Future approved importer and MCP tools

**Limits:** Not yet implemented; no EHR data read.



### Direct hospital network integration (unsupported)

Automatic uploads or writes into hospital portals.

**Needs:** Separate vendor-specific authorization and implementation

**Limits:** No direct hospital network access or writes. Preparing a briefing does not send it.

### User-provided stress summary (available)

Read a Stress Trends summary the user pastes from the WHOOP app. This is not a synced Stress Monitor feed.

**Needs:** A summary the user chooses to paste; optional connected recovery, sleep, or cycle data kept as a separate source

**Limits:** Not synced WHOOP Stress Monitor data, and this tool does not store the paste. Cannot calculate non-activity high-stress hours from strain, heart rate, or HRV.

**Try:** Here is my WHOOP stress summary. Label it as user-provided and compare it only with my recovery and sleep.

### WHOOP Stress Monitor history (unsupported)

Daily low, medium, and high physiological stress durations, including non-activity high stress.

**Needs:** An official WHOOP Stress Monitor endpoint, which the public developer API does not provide

**Limits:** No stress-zone timeline or high-stress duration totals are returned. Strain, average heart rate, and HRV must not be converted into stress hours.



## Privacy and AI client support

The public catalog contains no account data. The server decides availability for each signed-in user. The AI client controls visuals and browsing, so missing host capabilities must be disclosed rather than claimed.
