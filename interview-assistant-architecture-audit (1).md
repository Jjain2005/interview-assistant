# Interview Assistant — Architecture Audit
### Calendar-First Identity Resolution vs. the Legacy Meet→People Pipeline

**Scope note on sourcing:** Every claim below is tagged **[V]** verified directly against current official Google documentation (developers.google.com / cloud.google.com / developer.chrome.com), **[I]** inferred from official docs but not explicitly stated, or **[A]** an assumption in your design that Google does not guarantee. Third-party blog claims (e.g. Stitchflow's "Meet User Management API Guide") are called out explicitly and never treated as authoritative — some of that source's own claims (e.g. a "primaryEmail" field returned directly by the Meet API) do **not** appear in the official `Participant` resource and should be discounted.

---

## 1. EXECUTIVE VERDICT

Your NEW architecture is directionally correct and is the one to build. The core insight — **Calendar defines expected identity, Meet defines actual attendance, People API is optional enrichment, never a dependency** — is exactly what the official documentation supports. The OLD architecture's central failure mode is real and documented: Meet's `SignedinUser.user` is a `users/{id}` handle that is only *interoperable* with the People API, not an email address, and the People API frequently cannot resolve it to `emailAddresses` for an external, non-domain user **[V]**.

However, the NEW architecture as written is **not yet safe to ship**. It has three unresolved correctness gaps that must be fixed before it can claim "never silently assign the wrong candidate":

1. **`attendee.id` is not documented as equivalent to `signedinUser.user`.** Your design doesn't explicitly rely on this, but Section 5/C of your brief flirts with it — I confirm below they must be treated as two different, non-interoperable identifier spaces **[V]**.
2. **The 1:1 fallback (Section D) is not "safe" or "unsafe" — it's a probability spectrum**, and several of your 13 listed cases (multi-device joins, phone dial-in, wrong-account join) can silently defeat it even in a "1 interviewer + 1 candidate" calendar event. This needs a stricter validation layer than "count non-interviewer participants."
3. **The Meet API's authorization model is scoped to "your Google Meet conferences"** — i.e., spaces the token owner created or was granted access to **[V]**. If the interviewer is not the organizer/creator of the Meet space (e.g., HR scheduled it and added the interviewer only as a Calendar attendee), read access to the conference record is *not guaranteed* by documentation and needs to be tested, not assumed **[A→ must verify]**.

None of these require a backend. All are addressable with the state machine in Section 13 and the ambiguity-first design principle you already stated.

---

## 2. WHAT WAS WRONG WITH THE OLD ARCHITECTURE

The OLD pipeline (`Meet → People API → candidate email → match Sheet`) has one structural flaw: it tries to derive an **external person's email address from a Meet participant ID**, and Google's documentation does not provide a guaranteed path to do that.

- `Participant.signedinUser.user` is documented as: *"Unique ID for the user. Interoperable with Admin SDK API and People API. Format: `users/{user}`"* **[V]**. Interoperable does **not** mean "resolvable to email." It means the ID can be passed as a resource name to those APIs — what comes back depends on the target user's profile visibility and your authorization.
- The People API's `people.get` documentation states: *"No authorization required to access public data. For private data, one of the following OAuth scopes is required[...]"* **[V]**. A candidate's email is **private data relative to your app** unless (a) they've made it public, or (b) they're a Google Workspace user in a domain you have Directory/People visibility into, or (c) they're already a "contact" of the authenticated interviewer. For an arbitrary external candidate (a personal Gmail address, a different company's Workspace domain), none of these are guaranteed, so `emailAddresses` legitimately comes back empty on an HTTP 200 — this is expected behavior, not a bug **[I]**, and it is why your discovered failure mode is real and structural, not incidental.
- Consequently, the OLD architecture had no reliable way to distinguish "candidate" from "interviewer" among Meet participants for any candidate outside the interviewer's Google contacts/domain. It could only work by accident (candidate happens to be a resolvable contact) — which is not production-grade.

**Verdict: the OLD architecture's core assumption ("Meet participant ID → email, always") is unsupported by documentation.** Discarding People API as the *primary* identity mechanism is correct.

---

## 3. VALIDATION OF THE NEW ARCHITECTURE

The NEW architecture's premise checks out against documentation on the points that matter most:

- **Calendar exposes attendee emails directly**, without needing Meet or People API at all. `EventAttendee.email` is documented as: *"The attendee's email address, if available. This field must be present when adding an attendee... Required when adding an attendee"* **[V]**. Practically: any attendee added via the normal invite flow (typing an email into the guest list) has `email` populated. This is a *far* more reliable source of "who is scheduled" than deriving identity from Meet.
- **`calendar.events.readonly` is the correct minimum scope** for reading events + attendees + conferenceData. Google's own scope description: *"View events on all your calendars"* **[V]**, distinct from `calendar.readonly` which also grants calendar *list/metadata* access you don't need. This satisfies your least-privilege requirement (Section J/H).
- **Meet API remains authoritative for actual timing** (join/leave), which Calendar cannot provide. This division of labor (Calendar = intent, Meet = fact) is architecturally sound and matches how Google's own examples treat these APIs as complementary, not redundant.

So: yes, Calendar-as-identity-source + Meet-as-attendance-source is validated. What is **not yet validated** is the specific matching algorithm in Section 5 — see Sections 5 and 8 below.

---

## 4. CRITICAL ASSUMPTIONS THAT ARE SAFE

| Assumption | Status |
|---|---|
| Calendar attendee emails are populated for normally-invited attendees | **[V]** Safe — documented, required field when adding attendees |
| `calendar.events.readonly` is sufficient to read attendees + conferenceData | **[V]** Safe — scope grants event read, which includes attendees and conferenceData per the Event resource |
| Meet `ParticipantSession` can have multiple sessions per participant (rejoin = new session) | **[V]** Safe — explicitly documented: *"any time a user joins the conference a new unique ID is assigned... if a user joins a space multiple times from the same device, they're assigned different IDs"* |
| People API should not be a mandatory dependency for external candidate identity | **[V]** Safe — confirmed by the private-data authorization gate above |
| Google Sheets header-name-based column writing (already working) doesn't need to change | **[A, but low-risk]** Not a Google API question; keep as-is per your own "don't redesign working components" rule |
| Recurring event instances retrieved via `singleEvents=true` do not carry a `recurrence` field, and behave like single events for matching | **[V]** Safe — documented in the Recurring Events guide |

---

## 5. CRITICAL ASSUMPTIONS THAT ARE NOT SAFE

These are the load-bearing risks in your NEW design that need explicit handling, not silent trust.

### 5.1 `attendee.id` ≠ Meet `signedinUser.user` — CONFIRMED DIFFERENT
`EventAttendee.id` is documented only as: *"The attendee's Profile ID, if available"* **[V]** — no format spec, no stated interoperability with Meet, Admin SDK, or People API, and in current practice this field is frequently absent (it's a legacy Google+ profile identifier that Calendar rarely populates today). Meanwhile `signedinUser.user` explicitly declares interoperability with **Admin SDK and People API only** — Calendar is conspicuously not on that list **[V]**. **Do not attempt to correlate these two IDs directly.** Your design already avoids doing this by matching on *email*, which is correct — just make sure no future engineer "optimizes" this by trying `attendee.id == signedinUser.user`, because it will silently fail or silently produce false negatives.

### 5.2 The 1:1 fallback is a heuristic, not a guarantee
Your Priority 2 rule ("exactly one non-interviewer participant → that's the candidate") is reasonable as a *default*, but it is not something Google's APIs certify as correct — it's an inference from meeting shape, and several of your own listed cases break it silently if not explicitly guarded:

- **Candidate joins from two devices** (laptop + phone camera backup): now there are 2 non-interviewer participants → correctly falls to your Priority 3 "ambiguous," *if* your counting logic accounts for this. If it naively picks "the first non-interviewer participant," it can pick the wrong session.
- **Candidate joins anonymously** (declined mic/camera permission prompt, or joined via a link without being signed in): they show up as `anonymousUser`, not `signedinUser`. Still "the only non-interviewer participant," so the 1:1 fallback *is* safe here — but your matching code must not assume `signedinUser` is present before applying the fallback.
- **Candidate joins from a different Google account than their Calendar-invited email**: the fallback is still safe procedurally (still 1 non-interviewer participant) but your *email cross-check* (People API resolves an email that doesn't match Calendar) will conflict with your fallback logic. Rule to add: **if People API returns a resolved email that mismatches the Calendar candidate email, treat as AMBIGUOUS even under the 1:1 shape** — don't let a successful-but-wrong People API resolution override the fallback silently.
- **Interviewer joins from two devices**: this is the dangerous case your matrix doesn't fully resolve — now there are 2 "interviewer-like" participants and possibly still 1 true non-interviewer participant. Your identify-the-interviewer step must match **by resolvable identity** (the currently authenticated interviewer's own account, which People API/`people/me` resolves reliably since it's the *authenticated user themself*, not an arbitrary external party) and explicitly exclude *both* interviewer sessions before counting "remaining" participants, not just the first one found.
- **Observer present but not on the Calendar invite**: this breaks the 1:1 count entirely and correctly routes to AMBIGUOUS — good, as long as observers aren't accidentally added to the Sheet as "interviewer."

**Recommendation:** implement the fallback as: *exclude all participants matching the authenticated interviewer's identity (by session correlation, not just count) → if exactly one remaining distinct person (by participant resource name, not session) → candidate; else → AMBIGUOUS.* Count **distinct participants**, not distinct **sessions** (a rejoin must not look like a second person).

### 5.3 Meet API authorization scope may not cover events the interviewer didn't create
`spaces.get`, `conferenceRecords.get`, and `conferenceRecords.participants.get` all require `meetings.space.created` or `meetings.space.readonly` **[V]**. The .NET client library documents `meetings.space.readonly` as *"Read information about any of your Google Meet conferences"* **[V]** — the phrase "your" is significant. Google's docs do not spell out, in the pages retrieved, whether "your conferences" includes spaces you were merely invited to as a Calendar attendee/participant vs. spaces you created. In practice, Meet API access for conference records generally does work for any participant who actually joined the meeting (this is the intended interviewer-facing use case the API was built for), but **this is not explicitly guaranteed in the pages available to this research** — treat it as **[A → verify with a real interviewer-not-organizer test]** before relying on it in production. If it turns out interviewer must be the Calendar organizer/Meet space creator, that becomes a hard product constraint you need to document (e.g. "interviews must be scheduled by the interviewer, not by HR on their behalf").

### 5.4 Recurring events and Meet code reuse
Google's recurring-events documentation confirms recurring events are stored as one parent event with an RRULE, and `singleEvents=true` expands instances **[V]**, but the pages retrieved for this research do not explicitly confirm whether **every instance of a recurring series shares the exact same `conferenceData.conferenceId`**, or whether Google Meet allocates a fresh conference/meeting code per occurrence in some configurations (e.g., "smart chip" video-call links added per instance vs. inherited from the series). **This is a genuine open question that must be verified empirically** — create a recurring test event and inspect `conferenceData.conferenceId` across three occurrences before trusting conferenceId-only matching. Practical consequence: your matching strategy (Section 8) must additionally use event `start.dateTime` proximity to the actual meeting-open time, not conferenceId alone, specifically *because* recurring interviews (unlikely for 1:1 candidate interviews, but your brief explicitly asks you to support them) could otherwise resolve to the wrong day's row in the Sheet.

---

## 6. GOOGLE API FINDINGS

### 6.1 Google Meet API (`meet.googleapis.com`, v2)
- Resources: `conferenceRecords`, `conferenceRecords.participants`, `conferenceRecords.participants.participantSessions`, `conferenceRecords.recordings`, `conferenceRecords.transcripts` **[V]**. Source: developers.google.com/workspace/meet/api/reference/rest/v2
- `Participant.name` format: `conferenceRecords/{conference_record}/participants/{participant}` **[V]**
- `Participant` is a union of exactly one of `signedinUser`, `anonymousUser`, `phoneUser` **[V]**. Only `signedinUser` carries an ID (`user: string`, format `users/{user}`) and it is explicitly scoped as interoperable with **Admin SDK API and People API** — not Calendar **[V]**.
- `ParticipantSession`: `{name, startTime, endTime}`. Rejoining — even from the same device — creates a new session ID; `endTime` is unset while the session is active **[V]**.
- Required scopes for read access: `meetings.space.created` or `meetings.space.readonly` (participants/spaces), described respectively as covering conferences "created by the app" and "any of your Google Meet conferences" **[V]**. Neither scope requires Workspace admin privileges or domain-wide delegation for standard per-user access.
- Source: developers.google.com/workspace/meet/api/reference/rest/v2/conferenceRecords.participants ; .../conferenceRecords.participants.participantSessions

### 6.2 People API (`people.googleapis.com`, v1)
- `people.get` requires the `personFields` query param (400 error if omitted) **[V]**.
- Authorization: *"No authorization required to access public data. For private data, one of the following OAuth scopes is required"* **[V]** — this is the documented basis for "People API can return 200 with no email for an external candidate." Source: developers.google.com/people/api/rest/v1/people/get
- `emailAddresses` is a valid `personFields` value, but availability is gated by the target person's profile visibility settings and your relationship to them (contact, same domain, or public profile) — not guaranteed by the API contract for arbitrary third parties.

### 6.3 Google Calendar API (`calendar.googleapis.com`, v3)
- `events.list` supports `timeMin`, `timeMax`, `singleEvents`, `q`, and pagination; `singleEvents=true` expands recurring events into instances that omit the `recurrence` field **[V]**. Source: developers.google.com/workspace/calendar/api/v3/reference/events/list ; developers.google.com/workspace/calendar/api/guides/recurringevents
- `EventAttendee` fields: `email` (required when adding), `displayName`, `id` ("Profile ID, if available" — no interoperability statement), `organizer` (read-only boolean), `responseStatus` **[V]**. Source: developers.google.com/workspace/calendar/api/v3/reference/events/update
- Scopes, from narrowest to broadest relevant to this project: `calendar.events.readonly` ("View events on all your calendars") < `calendar.events` (adds write) < `calendar.readonly` (adds calendar list/metadata read) < `calendar` (full read/write) **[V]**. Source: developers.google.com/workspace/calendar/api/auth

### 6.4 Chrome Extensions — `chrome.identity`, Manifest V3
- `getAuthToken()`: *"The Identity API caches access tokens in memory... For a good user experience it is important interactive token requests are initiated by UI... do not use getAuthToken interactively when your app is first launched."* **[V]**. `scopes` param, if present, **overrides** manifest.json's declared scopes for that call **[V]**. Source: developer.chrome.com/docs/extensions/reference/api/identity
- `clearAllCachedAuthTokens()` removes all cached tokens and de-authorizes the user from all auth flows — useful for a "switch Google account" flow, not for routine scope upgrades **[V]**.
- `chrome.alarms`: alarms survive service-worker idle-termination, but persistence **across full browser restarts is not guaranteed**, and Chrome engineers explicitly recommend re-registering/checking alarms every time the service worker starts **[V]**. Source: Chromium extensions group (Chrome DevRel response), corroborated by developer.chrome.com/docs/extensions/reference/api/alarms.
- Best-practice guidance consistently documented: register `onAlarm`/`onMessage` listeners at the **top level** of the service worker script (not inside an async callback), or events fired while the worker was being woken up can be missed **[V/I]**.

---

## 7. OLD VS NEW COMPARISON TABLE

| Category | OLD | NEW | Winner | Reason |
|---|---|---|---|---|
| Candidate identity reliability | Depends on People API resolving an arbitrary external user | Calendar attendee email, directly authoritative | **NEW** | Calendar email is a required, populated field; People API resolution of external users is not guaranteed |
| Interviewer identity | Authenticated Google account (works today) | Same, unchanged | Tie | Both use `people/me`, which is reliable since it's the authenticated user |
| External candidates | Frequently unresolvable | Directly available via Calendar invite | **NEW** | Core fix |
| Calendar integration | None | Core dependency | **NEW** | Required for the fix, adds one moderate-sensitivity scope |
| Meet integration | Core, overloaded (identity + timing) | Scoped to timing/attendance only | **NEW** | Cleaner separation of concerns |
| People API dependency | Mandatory | Optional enrichment (Priority 1 only) | **NEW** | Removes a hard failure point |
| API permissions | `meetings.space.readonly`, People scopes | + `calendar.events.readonly` | **NEW slightly more surface, but justified** | One additional scope for a load-bearing capability |
| OAuth complexity | Lower (fewer scopes) | Slightly higher (one more scope, one more consent screen) | OLD (complexity), **NEW (net value)** | Extra complexity is small and one-time |
| Privacy | Reads Meet participant + attempts People resolution of external people | Reads own Calendar (already interviewer's own data) + Meet attendance | **NEW** | Calendar read is scoped to interviewer's own calendar; doesn't probe external people's profiles |
| Production reliability | Breaks silently on any external candidate | Explicit ambiguity detection | **NEW** | Matches "never silently guess" requirement |
| Implementation complexity | Lower | Moderate (new matching + ambiguity states) | OLD (simplicity), **NEW (correctness)** | Correctness > simplicity for this product |
| Maintenance | Simple but fragile | More moving parts, but each part has one job | **NEW** | Easier to debug because failure domains are separated |
| Failure modes | Wrong-candidate risk is silent | Explicit STOP/FLAG on mismatch | **NEW** | Directly satisfies your engineering rule #5 |
| Multi-attendee meetings | No handling | Explicit AMBIGUOUS path | **NEW** | — |
| Recurring events | N/A (not calendar-aware) | Handled, but conferenceId-per-instance behavior needs verification | **NEW, with an open item** | See 5.4 |
| Candidate rejoin | Handled by session list already | Unchanged (same Meet API) | Tie | Not affected by the identity-flow change |
| Interviewer rejoin | Handled by session list already | Unchanged, but must exclude *all* interviewer sessions before counting remaining participants | Tie, with a fix needed | See 5.2 |
| Delayed Meet data | Handled by existing retry system | Unchanged, preserved | Tie | Retry system explicitly preserved per your rules |
| Wrong-candidate risk | High and silent | Low, with explicit stop conditions | **NEW** | Core motivation for the redesign |
| Scalability | Fine for current volume either way | Fine | Tie | Neither introduces a backend or a scaling bottleneck |
| Backend requirement | None | None | Tie | NEW architecture achieves the goal without a backend |
| Observability/debugging | Failure only visible as "no email" with no context | Explicit state machine + AMBIGUOUS/MISMATCH flags | **NEW** | Directly supports Section M failure matrix |

**Net: NEW wins on every correctness and safety dimension; OLD wins only on raw simplicity, which is the wrong axis to optimize for a system whose explicit #1 rule is "never silently assign the wrong candidate."**

---

## 8. RECOMMENDED FINAL ARCHITECTURE

This maps closest to your **Architecture E** (Calendar → Meet → Chrome Extension → Sheets + local state), with People API demoted to a best-effort corroboration signal only. I do **not** recommend Architecture C (mandatory People API) for the reasons in Sections 2 and 6.2, and I do not recommend introducing Pub/Sub push notifications, domain-wide delegation, or a service account — none are necessary for a single-interviewer, per-user OAuth Chrome extension, and each would add a real cost (Workspace Admin approval, service-account key custody, backend infrastructure) that your requirements explicitly rule out.

```
Google Calendar (calendar.events.readonly)
    │
    ├─ find event where conferenceData.conferenceId == Meet code
    │  (search window: ±N days around "now", using timeMin/timeMax + singleEvents=true;
    │   NOT unbounded — see Section 9 for exact window)
    │
    ├─ read attendees[] → candidate email (expected identity)
    │
    ├─ cross-check candidate email against Google Sheets row
    │     match → continue
    │     mismatch → STOP, flag IDENTITY_MISMATCH, do not write
    │
    ▼
Google Meet API (meetings.space.readonly)
    │
    ├─ resolve conferenceRecord for the meeting code
    ├─ list participants + participantSessions (existing retry system, unchanged)
    ├─ identify interviewer session(s) = authenticated user (people/me), exclude ALL of them
    ├─ remaining distinct participants:
    │     0 → WAITING_FOR_CANDIDATE
    │     1 → candidate = that participant
    │           (optional) People API resolve → if resolved email conflicts with Calendar email → AMBIGUOUS
    │     2+ → AMBIGUOUS, requires interviewer manual confirmation in side panel
    │
    ▼
Timestamp calculation (Section 10) → Google Sheets write (existing header-based writer, unchanged)
```

No backend, no database, no Apps Script, no service account, no domain-wide delegation, no Pub/Sub. All state lives in `chrome.storage` (survives side panel close/service worker restart) plus the alarm-driven retry loop you already have.

---

## 9. IDENTITY-MATCHING ALGORITHM

**Calendar search strategy (Section G):** search around the Meet's actual open time, not "current time" generically — the interviewer could open the extension slightly before or after the scheduled slot. Recommended window: `timeMin = meetingOpenTime - 12h`, `timeMax = meetingOpenTime + 12h`, `singleEvents=true`, on `calendarId=primary`. This bounds the recurring-event expansion cost (see the pagination cost warning in Section 6.3) while being generous enough for early joins, late starts, and reasonable clock skew. Do not search by free-text `q` — it matches against summary/description/attendee fields with GC's fuzzy text index, not the exact conferenceId, and is not deterministic enough for identity-critical matching.

**Step-by-step:**
1. Extract Meet code from `meet.google.com/xxx-xxxx-xxx` URL (existing, working).
2. `GET /calendar/v3/calendars/primary/events?timeMin=...&timeMax=...&singleEvents=true`.
3. Filter results client-side for `conferenceData.conferenceId === meetCode`. If recurring-instance conferenceId reuse turns out to be true (open item, Section 5.4), **also** filter by `start.dateTime` closest to `meetingOpenTime` among candidates sharing the same conferenceId, and require the chosen instance's start to be within a tolerance window (e.g. ±2h) of the actual join — else STOP as `CALENDAR_EVENT_AMBIGUOUS`.
4. If zero matches → `CALENDAR_EVENT_NOT_FOUND`, do not guess; surface to interviewer for manual row selection.
5. If exactly one match → read `attendees[]`, exclude the organizer if `organizer.self === true` is the interviewer, extract remaining attendee(s) with a non-interviewer email.
6. If more than one plausible candidate attendee → `CALENDAR_CANDIDATE_AMBIGUOUS`, do not guess.
7. Cross-check the resolved Calendar candidate email against the Google Sheets row (exact, case-insensitive match). Mismatch → `IDENTITY_MISMATCH`, STOP, do not write, surface to interviewer.
8. Proceed to Meet-side resolution exactly as diagrammed in Section 8, applying the corrected "exclude all interviewer sessions by resource name before counting" rule from Section 5.2.
9. Never allow a successful People API email resolution to *override* a Calendar/Sheet mismatch — People API is corroborating evidence only, never a tiebreaker that promotes an ambiguous case to "resolved."

---

## 10. TIMESTAMP ALGORITHM

**Definitions (recommended, correcting your open question in Section F):**

- **Interviewer Join Time** = earliest `startTime` across all of the interviewer's participant sessions (handles multi-device/rejoin — first arrival, not first device).
- **Interviewer Leave Time** = latest `endTime` across all interviewer sessions, **only once every session has an `endTime`** (don't report a leave time while any session is still active/unset).
- **Candidate Join Time** = earliest `startTime` across all candidate sessions.
- **Candidate Leave Time** = latest `endTime` across all candidate sessions, same "wait for all sessions closed" rule.
- **Candidate Waiting Time** = `max(0, candidateJoin − interviewerJoin)`. Using `max(0, ...)` is correct, not the raw signed difference: if the interviewer joins after the candidate, "waiting time" should read as `0` for the interviewer-side metric (the candidate waited zero time *for the interviewer to be already there*), and the actual "candidate waited alone" duration is what you want to display, not a negative number that a spreadsheet reader will misread. If you *also* want to capture "how long did the candidate wait alone before the interviewer showed up," that's the same formula — `max(0, candidateJoin − interviewerJoin)` already **is** that value. If interviewer joined first, waiting time is correctly `0`.
- **Interview Duration**: recommend **SUM of overlapping-session duration**, not `lastLeave − firstJoin`. Rationale: `lastLeave − firstJoin` overstates duration if the candidate disconnected and rejoined with a gap (e.g., dropped call for 5 minutes) — that gap is not "interview time." The mathematically correct "how long did the interview actually run" is the union of the time intervals where **both** interviewer and candidate had an active session simultaneously — i.e., compute the intersection of interviewer-active-intervals and candidate-active-intervals, then sum the overlapping durations. This is more work than a naive subtraction but is the only definition that survives the "candidate leaves and rejoins" and "interviewer leaves and rejoins" edge cases in your own Section E questions 6–7. If engineering time is constrained, a documented, simpler fallback is `min(candidateLeave, interviewerLeave) − max(candidateJoin, interviewerJoin)` (single-session overlap) with a note in the Sheet when multiple sessions were detected, so no one interprets an approximate number as exact.
- **Meet data lag**: `endTime` "can be delayed after the meeting" is explicitly a caveat in the ParticipantSession semantics — never compute Interview Duration until you've confirmed (via the retry loop) that no participant has an active/unset session; that's exactly what your existing retry system already does — preserve it unchanged.

---

## 11. FAILURE / EDGE-CASE MATRIX

| # | Failure | Detection | Safe behavior | Retry? | User action needed? | Sheet updated? |
|---|---|---|---|---|---|---|
| 1 | Calendar API unavailable | HTTP 5xx/network error on events.list | Fall back to "no calendar match" state, don't guess | Yes, via alarm | No, transparent retry | No |
| 2 | Meet API unavailable | HTTP 5xx on conferenceRecords/participants | Preserve calendar match, wait for Meet data | Yes (existing retry loop) | No | No |
| 3 | People API unavailable | HTTP 5xx on people.get | Skip enrichment, proceed on Calendar+Sheet match alone | No — non-critical | No | Yes (unaffected) |
| 4 | Calendar event not found | Zero results in search window | `CALENDAR_EVENT_NOT_FOUND` | No | Yes — manual row selection | No |
| 5 | Meet code mismatch (extension parsed wrong code) | conferenceId filter yields zero after code was non-empty | Same as #4 | No | Yes | No |
| 6 | Candidate email mismatch (Calendar vs Sheet) | String compare fails | `IDENTITY_MISMATCH`, STOP | No | Yes — mandatory | No |
| 7 | Candidate not present in Calendar attendees | attendees[] has no non-interviewer entry | `CALENDAR_CANDIDATE_MISSING` | No | Yes | No |
| 8 | Candidate hasn't joined yet | 0 non-interviewer Meet participants | `WAITING_FOR_CANDIDATE`, keep polling | Yes | No | No |
| 9 | Candidate joins late | Handled naturally — join time recorded whenever session appears | Normal flow continues | N/A | No | Eventually, yes |
| 10 | Candidate leaves and rejoins | New participantSession with same participant resource | Sum sessions per Section 10 | N/A | No | Yes, correctly |
| 11 | Interviewer leaves and rejoins | Same, on interviewer's participant | Exclude by resource name across all sessions (Section 5.2 fix) | N/A | No | Yes |
| 12 | Multiple non-interviewer participants | count > 1 after exclusion | `AMBIGUOUS`, STOP | No | Yes — mandatory manual pick | No |
| 13 | People API returns no email | 200, emailAddresses absent | Ignore, rely on Calendar/Sheet match only | No | No | Unaffected |
| 14 | Meet participant is anonymous | `anonymousUser` union branch | Still countable for 1:1 fallback; cannot be People-cross-checked | N/A | No unless AMBIGUOUS | Unaffected |
| 15 | Calendar event cancelled | `status: "cancelled"` on the event | Treat as `CALENDAR_EVENT_NOT_FOUND` | No | Yes | No |
| 16 | Duplicate Calendar events (same conferenceId) | >1 result after filter | `CALENDAR_EVENT_AMBIGUOUS` (apply start-time tiebreak, Section 9) | No | Yes if still ambiguous | No |
| 17 | Recurring Calendar event | `recurrence` absent on instance (expected with singleEvents=true) | Normal flow — treat instance as a single event | N/A | No | Yes |
| 18 | Meet data delayed | `endTime` unset while meeting has visibly ended | Keep polling via alarm, don't finalize duration | Yes (existing) | No | No, until complete |
| 19 | Google token expired | 401 from any API | Silent non-interactive `getAuthToken()` refresh attempt first | Yes, once | Only if refresh also fails | No |
| 20 | OAuth scope missing (e.g. calendar scope not yet granted) | 403 insufficient scope | Trigger one **interactive** `getAuthToken({interactive:true, scopes:[...]})` call, with UI context first | No auto-retry | Yes — consent | No |
| 21 | Sheet row changed while interview running | Re-read row before final write, compare candidate email | If changed, re-validate match; if now mismatched, STOP | No | Yes | No, until re-validated |
| 22 | Multiple Meet tabs open | Multiple `chrome.tabs` with meet.google.com, or multiple side panel instances | Key active interview state by `meetCode` + `tabId`, not globally | N/A | No | Per-tab correct |
| 23 | Browser restarted | Service worker cold-starts, alarms may not have persisted | Re-register alarms and re-hydrate active-interview state from `chrome.storage` on `onStartup`/`onInstalled` | Yes, self-healing | No | No data loss if state was persisted before restart |
| 24 | Extension service worker restarted (idle timeout) | Normal MV3 behavior, frequent | All state must already be in `chrome.storage`, not in-memory globals | N/A | No | No, in-memory-only state would have been lost — this is why storage-first design is mandatory |

---

## 12. SECURITY AUDIT

- **Minimum OAuth scopes**: `calendar.events.readonly` (not `calendar.readonly`), `meetings.space.readonly` (not `.created`, since the extension doesn't create Meet spaces), People API `emailAddresses` field only (not full profile), plus whatever Sheets scope you already use for read/write. Do not request `calendar` (full write) or `meetings.space.settings`.
- **Host permissions**: restrict `content_scripts`/`host_permissions` to `https://meet.google.com/*`; do not request broad `<all_urls>`.
- **Candidate-side isolation**: because this is an extension the *interviewer* installs and authenticates, the candidate's browser never runs your code — there is no client-side risk of a candidate seeing interviewer-only UI unless the interviewer shares their screen while the side panel is visible. Document this as an operational caution to interviewers, not a code fix.
- **Preventing cross-candidate writes**: the mismatch/ambiguity STOP states in Sections 9 and 11 are your primary defense; additionally, before writing, re-verify the target Sheet row's candidate email still matches (case #21) to guard against concurrent edits.
- **Token handling**: rely on `chrome.identity.getAuthToken()`'s built-in in-memory cache; do not persist raw OAuth tokens into `chrome.storage` yourself — `chrome.storage.local` is not encrypted at rest in a way that's meaningfully more secure than the identity API's own cache, and duplicating token storage only creates a second place tokens can leak or go stale. No client secret is ever needed with `chrome.identity` — it uses Chrome's own OAuth client flow, so there is nothing to embed in the extension bundle.
- **XSS in candidate names/remarks**: since the side panel is your own extension UI (not the Meet page DOM), render candidate names/remarks via safe DOM APIs (`textContent`, or a framework's default escaping) — never `innerHTML` with unsanitized Sheet cell contents, since a compromised or maliciously-edited Sheet cell could otherwise inject script into your own privileged extension context.
- **Malicious Meet links**: your content script should only activate on the exact `meet.google.com` origin and validate the extracted meeting-code format (alphanumeric-hyphen pattern) before using it in any API call, to avoid path/query injection into your own REST calls.
- **Spreadsheet injection**: candidate-entered remarks written back to Sheets should be checked for leading `=`, `+`, `-`, `@` characters (classic CSV/formula-injection vectors) and prefixed/escaped if a leading formula-trigger character is present, since Sheets will otherwise interpret pasted or API-written text starting with those characters as a formula.
- **Logging**: avoid `console.log`-ing candidate emails, names, or remarks in production builds — service worker console output is inspectable via `chrome://extensions` dev tools by anyone with local machine access.
- **Caching candidate/Calendar data in `chrome.storage`**: acceptable and recommended for durability (Section 24 above requires it), but scope it to the *active interview only* and clear it on `INTERVIEW_COMPLETE`/`SHEET_UPDATED` — don't accumulate a growing local candidate-data cache across many interviews, which increases the blast radius if the local profile is compromised, and isn't needed once the Sheet has become the durable record.

---

## 13. STATE MACHINE

Your proposed state machine is close; the necessary changes are: an explicit branch point after `CANDIDATE_VALIDATED` for the Calendar/Sheet mismatch case, and an `AMBIGUOUS` state that is reachable from multiple points rather than being a dead end.

```
DISCOVERED
    │ (Meet code + tab detected)
    ▼
CALENDAR_SEARCHING
    │
    ├─ not found / cancelled / duplicate-unresolved → CALENDAR_EVENT_NOT_FOUND (terminal, needs manual pick)
    ▼
CALENDAR_MATCHED
    │ (attendees[] read)
    ▼
CANDIDATE_VALIDATED   ──mismatch──▶ IDENTITY_MISMATCH (terminal, needs manual resolution)
    │ match
    ▼
MEET_ACTIVE
    │ (conferenceRecord resolved, participants polling begins — existing retry loop)
    ▼
WAITING_FOR_CANDIDATE
    │
    ├─ 0 non-interviewer participants → stay here (poll)
    ├─ 1 non-interviewer participant  → CANDIDATE_IDENTIFIED
    └─ 2+ non-interviewer participants → AMBIGUOUS
                                              │ (interviewer manually selects, or confirms none)
                                              ▼
                                        CANDIDATE_IDENTIFIED (manually confirmed)
    ▼
INTERVIEW_IN_PROGRESS
    │ (both sides have at least one active session)
    ▼
MEET_ENDED
    │ (no more active sessions observed)
    ▼
WAITING_FOR_FINAL_MEET_DATA
    │ (existing retry loop: poll until all sessions have endTime)
    ▼
TIMELINE_COMPLETE
    │ (compute timestamps per Section 10)
    ▼
AWAITING_OUTCOME_ENTRY
    │ (interviewer selects Selected/Rejected/No Show 1/No Show 2/Hold + remark)
    ▼
SHEET_UPDATE_PENDING
    │
    ├─ row changed / mismatch on re-check → IDENTITY_MISMATCH (re-flagged, blocks write)
    ▼
SHEET_UPDATED (terminal, success)
```

Every terminal-looking "problem" state (`CALENDAR_EVENT_NOT_FOUND`, `IDENTITY_MISMATCH`, `AMBIGUOUS`) should be user-visibly surfaced in the side panel with a manual override path — none of them should silently drop the interview.

---

## 14. PRODUCTION READINESS SCORE

- **OLD architecture: 3/10.** Works for interviewers whose candidates happen to be resolvable via People API (internal hires, existing contacts); fails silently and unpredictably for the majority external-candidate case, which is your actual product's core use case. Not production-safe for its stated purpose.
- **NEW architecture (as specified in your brief, before this audit's fixes): 6/10.** Correct core premise, but the unresolved items in Section 5 (interviewer-session exclusion by resource not count, Meet-API-authorization-for-non-organizer verification, recurring-conferenceId verification) are exactly the kind of "quietly wrong 5% of the time" gaps that violate your own rule #1.
- **Recommended architecture (this document's Sections 8–13 applied): 8.5/10.** What prevents a 10/10: (a) the two explicitly-flagged **[A → must verify]** items in Section 5.3 and 5.4 are not resolvable from documentation alone and require a real empirical test against your Workspace before this can be called fully verified; (b) the "sum of overlapping sessions" duration formula (Section 10) needs actual implementation and a unit-test suite against synthetic multi-session data before you can trust it in production; (c) service-worker cold-start rehydration (case #23) needs to be built and tested, not just designed.

**What must be fixed before production:** the two verification items above, the interviewer-session exclusion logic, and end-to-end testing of the AMBIGUOUS/MISMATCH manual-resolution UI in the side panel.
**What can wait:** People API enrichment as a nice-to-have corroboration signal, formula-injection escaping polish, and any UI refinement — none of these affect correctness of candidate identity or timestamps.

---

## 15. EXACT IMPLEMENTATION PLAN

### PHASE 1 — Calendar API proof-of-concept
- **Files to modify:** new `calendarClient.js` (or equivalent) in the service worker; `manifest.json` (add `calendar.events.readonly` to `oauth2.scopes`).
- **Files NOT to modify:** existing Sheets writer, existing Meet client, existing retry/alarm system.
- **APIs:** `GET /calendar/v3/calendars/primary/events`.
- **OAuth scopes:** add `https://www.googleapis.com/auth/calendar.events.readonly`.
- **Tests:** manually create a test Calendar event with a Meet link, confirm `conferenceData.conferenceId` is retrievable and matches the Meet URL code; test with a recurring event to check conferenceId stability across instances (resolves the Section 5.4 open item).
- **Expected console output:** the matched event's `id`, `conferenceData.conferenceId`, and `attendees[]`.
- **Success criteria:** conferenceId extracted from a real Meet URL reliably locates the correct Calendar event in a bounded time window.
- **Rollback:** remove the new scope and client file; no impact on existing working system since nothing else was touched.

### PHASE 2 — Calendar + Sheet identity validation
- **Files to modify:** new `identityMatcher.js`; existing Sheets reader (read-only integration point, not the writer).
- **Files NOT to modify:** Meet client, retry system.
- **APIs:** Calendar (from Phase 1) + existing Sheets read.
- **Scopes:** unchanged from Phase 1.
- **Tests:** matched-email case, deliberate-mismatch case, candidate-missing-from-attendees case.
- **Expected console output:** `MATCH`/`MISMATCH`/`CANDIDATE_MISSING` with both emails logged (redact in production build per Section 12).
- **Success criteria:** mismatch reliably blocks progression to Phase 3 states.
- **Rollback:** disable the matcher call; Sheet reading itself is unaffected.

### PHASE 3 — Calendar + Meet participant correlation
- **Files to modify:** existing Meet participant-polling code (extend, don't replace), `identityMatcher.js`.
- **Files NOT to modify:** Sheets writer, retry/alarm scheduling logic itself (only the data it operates on changes).
- **APIs:** Meet API (existing) + Calendar (Phase 1) + People API (optional enrichment only).
- **Scopes:** confirm `meetings.space.readonly` already present; add People API email scope if not already present.
- **Tests:** the full matrix in Section 5.2 — single candidate, candidate+observer, candidate joins twice, interviewer joins twice, anonymous candidate. **Also explicitly test: interviewer NOT the Calendar organizer**, to resolve the Section 5.3 open item.
- **Expected console output:** resolved candidate participant resource name, or `AMBIGUOUS` with the list of remaining participants.
- **Success criteria:** correct candidate identified in the 1-candidate case in 100% of test runs; AMBIGUOUS correctly triggered in every multi-participant test case; zero silent misassignments.
- **Rollback:** feature-flag back to People-API-only matching temporarily if correlation logic has a defect, while keeping the Calendar mismatch STOP as a safety net.

### PHASE 4 — Timestamp calculation
- **Files to modify:** new/updated `timestampCalculator.js`.
- **Files NOT to modify:** everything else.
- **APIs:** none new — consumes already-fetched `participantSessions`.
- **Tests:** unit tests with synthetic multi-session data covering: normal single session both sides, candidate rejoin with gap, interviewer rejoin with gap, overlapping vs. non-overlapping sessions.
- **Expected console output:** computed Interviewer/Candidate Join/Leave, Waiting Time, Duration, plus a flag if multiple sessions were detected (for the simplified-fallback note in Section 10).
- **Success criteria:** all unit tests pass; duration never exceeds `latestEndTime − earliestStartTime` of the whole conference record (a sanity ceiling).
- **Rollback:** revert to naive `lastLeave − firstJoin` behind a flag if the overlap calculation has a defect, with the multi-session flag prominently shown so the number is known to be approximate.

### PHASE 5 — Retry/reliability
- **Files to modify:** existing alarm/service-worker restart handlers, extended to rehydrate the new state machine (Section 13) from `chrome.storage`.
- **Files NOT to modify:** core alarm-scheduling logic that already works.
- **Tests:** simulate service-worker termination mid-interview (via `chrome://extensions` "service worker" restart button) and confirm state resumes correctly; simulate browser restart.
- **Expected console output:** state-machine current state logged on every wake, confirming correct resume point.
- **Success criteria:** no state loss across service-worker idle/restart; no duplicate Sheet writes on resume.
- **Rollback:** N/A — this phase only strengthens existing durability, no new external dependency.

### PHASE 6 — Security hardening
- **Files to modify:** Sheet-write sanitization (formula-injection guard), side-panel rendering (XSS guard), logging calls (redact PII).
- **Tests:** attempt to write a remark starting with `=`, confirm it's escaped in the Sheet; attempt to inject `<script>` via a candidate name field, confirm it renders as text.
- **Success criteria:** no formula execution in Sheets from written remarks; no script execution in the side panel from any Sheet-sourced string.
- **Rollback:** N/A — purely additive hardening.

### PHASE 7 — Production testing
- **Tests:** full end-to-end run with a real scheduled interview, real external candidate email, real join/leave/rejoin behavior, confirmed correct Sheet write; explicit adversarial tests for each row of the Section 11 failure matrix.
- **Success criteria:** every failure-matrix row produces its documented "safe behavior," and the two `[A]`-flagged open items from Section 5 are now empirically resolved and documented as `[V — verified in our environment]` or handled by a documented product constraint.
- **Rollback strategy for the whole rollout:** keep the OLD Meet→People matching path available behind a feature flag for one release cycle as a fallback signal only (never as the primary decision-maker), so you can compare NEW-architecture outcomes against the old heuristic during initial production soak without regressing safety.

---

## 16. TEST PLAN

- **Unit tests:** timestamp calculator (Phase 4 cases), identity matcher (email match/mismatch/missing), interviewer-session exclusion logic (Section 5.2 fix).
- **Integration tests:** Calendar→Meet correlation across the full Section 5.2 device/rejoin/anonymous matrix; recurring-event conferenceId behavior (Section 5.4); non-organizer interviewer Meet-API access (Section 5.3).
- **Resilience tests:** service-worker idle termination mid-interview, browser restart mid-interview, multiple Meet tabs open simultaneously, Sheet row edited concurrently by another user.
- **Security tests:** formula-injection strings in remarks, script-injection strings in candidate name, verifying no OAuth client secret exists in the built extension bundle, verifying requested scopes match exactly the minimum list in Section 12.
- **Regression tests:** confirm existing header-based Sheet writer, existing Meet participant pagination, and existing retry/alarm system behave identically to their pre-audit state (per your explicit "preserve working components" rule).

---

## 17. SOURCES

- Google Meet API — Participants resource: https://developers.google.com/workspace/meet/api/reference/rest/v2/conferenceRecords.participants
- Google Meet API — ParticipantSessions resource: https://developers.google.com/workspace/meet/api/reference/rest/v2/conferenceRecords.participants.participantSessions
- Google Meet API — overview/REST resources: https://developers.google.com/meet/api/reference/rest/v2
- Google Meet API — spaces.get authorization scopes: https://developers.google.com/workspace/meet/api/reference/rest/v2/spaces/get
- Google Meet API — conferenceRecords.participants.get authorization scopes: https://developers.google.com/workspace/meet/api/reference/rest/v2/conferenceRecords.participants/get
- Google Meet API — Respond to events from Google Meet (participantSessions usage): https://developers.google.com/workspace/meet/api/guides/events-overview
- People API — people.get method reference (authorization/personFields): https://developers.google.com/people/api/rest/v1/people/get
- People API — profiles code samples: https://developers.google.com/people/v1/profiles
- Google Calendar API — Events: list reference: https://developers.google.com/workspace/calendar/api/v3/reference/events/list
- Google Calendar API — Events: update reference (EventAttendee fields): https://developers.google.com/workspace/calendar/api/v3/reference/events/update
- Google Calendar API — Recurring events guide: https://developers.google.com/workspace/calendar/api/guides/recurringevents
- Google Calendar API — Choose Calendar API scopes: https://developers.google.com/workspace/calendar/api/auth
- Chrome Extensions — chrome.identity reference: https://developer.chrome.com/docs/extensions/reference/api/identity
- Chrome Extensions — chrome.alarms reference: https://developer.chrome.com/docs/extensions/reference/api/alarms
- Chromium extensions developer group — alarms/service-worker persistence discussion (Chrome DevRel response): https://groups.google.com/a/chromium.org/g/chromium-extensions/c/k5upFLVnPqE

**Not used as authoritative (flagged, not relied upon for any claim above):** a third-party integration blog ("Stitchflow — Google Meet User Management API Guide") which describes a `primaryEmail` field and Admin-SDK cross-referencing pattern not present in the official `Participant` resource schema — mentioned here only to explicitly discount it, since it could otherwise be mistaken for an officially-documented shortcut to resolving candidate emails.
