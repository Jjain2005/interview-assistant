/**
 * contacts.js
 *
 * Idempotent People API contact seeding.
 *
 * Public API:
 *
 *   ensureCandidateContact(email, name, token)
 *     → single-email idempotent seed
 *
 *   seedAllSheetCandidates(token)
 *     → reads every row from the Sheet, seeds every unique
 *       candidate email in one efficient pass
 */


/* =========================================================
   PEOPLE API BASE
========================================================= */

const CONTACTS_PEOPLE_BASE =
  "https://people.googleapis.com/v1";

const SEEDED_EMAILS_KEY =
  "seededContactEmails";


/* =========================================================
   INTERNAL: RAW FETCH AGAINST PEOPLE API
========================================================= */

async function _contactsApiRequest(url, options, token) {

  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options?.headers || {}),
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json"
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`People API ${response.status}: ${text}`);
  }

  if (response.status === 204) return null;

  return response.json();
}


/* =========================================================
   INTERNAL: LOAD SEEDED EMAIL CACHE FROM chrome.storage
   Returns a Set of lowercase emails already confirmed seeded.
========================================================= */

async function _loadSeededCache() {
  try {
    const stored = await chrome.storage.local.get(SEEDED_EMAILS_KEY);
    return new Set(stored[SEEDED_EMAILS_KEY] || []);
  } catch (_) {
    return new Set();
  }
}


/* =========================================================
   INTERNAL: SAVE UPDATED SEEDED EMAIL CACHE TO chrome.storage
========================================================= */

async function _saveSeededCache(emailSet) {
  try {
    await chrome.storage.local.set({
      [SEEDED_EMAILS_KEY]: [...emailSet]
    });
  } catch (err) {
    console.warn("[contacts] Could not save seeded cache:", err.message);
  }
}


/* =========================================================
   LOAD ALL EXISTING CONTACT EMAILS
   Paginates through connections.list ONCE and caches in memory.
   Returns a Set of lowercase email strings.
========================================================= */

let _inMemoryContactEmails = null;

async function _loadAllContactEmails(token, forceRefresh = false) {

  if (!forceRefresh && _inMemoryContactEmails && _inMemoryContactEmails.size > 0) {
    return _inMemoryContactEmails;
  }

  const emailSet = new Set();
  let pageToken = null;

  do {

    const params = new URLSearchParams({
      personFields: "emailAddresses",
      pageSize: "1000"
    });

    if (pageToken) {
      params.set("pageToken", pageToken);
    }

    const url =
      `${CONTACTS_PEOPLE_BASE}/people/me/connections?` +
      params.toString();

    let data;
    try {
      data = await _contactsApiRequest(url, {}, token);
    } catch (err) {
      console.warn("[contacts] connections.list error:", err.message);
      break;
    }

    const connections = data.connections || [];

    for (const person of connections) {
      for (const e of (person.emailAddresses || [])) {
        const v = (e.value || "").trim().toLowerCase();
        if (v) emailSet.add(v);
      }
    }

    pageToken = data.nextPageToken || null;

  } while (pageToken);

  console.log(
    `[contacts] Loaded ${emailSet.size} existing contact email(s).`
  );

  _inMemoryContactEmails = emailSet;
  return emailSet;
}


/* =========================================================
   CREATE A NEW CONTACT WITH THE CANDIDATE EMAIL
========================================================= */

async function _createContact(email, name, token) {

  const url =
    `${CONTACTS_PEOPLE_BASE}/people:createContact` +
    `?personFields=emailAddresses,names`;

  const body = {
    emailAddresses: [{ value: email, type: "work" }]
  };

  if (name) {
    const parts = name.trim().split(/\s+/);
    const firstName = parts[0] || "";
    const lastName = parts.slice(1).join(" ") || "";
    body.names = [{ givenName: firstName, familyName: lastName }];
  }

  const person = await _contactsApiRequest(
    url,
    {
      method: "POST",
      body: JSON.stringify(body)
    },
    token
  );

  console.log(
    `[contacts] Created contact for ${email}:`,
    person.resourceName
  );

  if (_inMemoryContactEmails) {
    _inMemoryContactEmails.add(email);
  }

  return person;
}


/* =========================================================
   PUBLIC: ensureCandidateContact
   Single-email idempotent seed.
   Used when loading one candidate from the Meet URL.

   @param {string} email   Candidate email from Sheet
   @param {string} name    Candidate name (optional)
   @param {string} token   Valid OAuth token with contacts scope

   @returns {object}
     { status: "EXISTS"|"CREATED"|"FAILED", resourceName?, error? }
========================================================= */

async function ensureCandidateContact(email, name, token) {

  if (!email || !token) {
    console.warn("[contacts] ensureCandidateContact: missing email or token.");
    return { status: "FAILED", error: "Missing email or token" };
  }

  const normalizedEmail = email.trim().toLowerCase();
  const normalizedName  = (name || "").trim();

  console.log(`[contacts] ensureCandidateContact: ${normalizedEmail}`);

  try {

    // ── 1. Check local cache first (fastest path) ────────
    const cache = await _loadSeededCache();
    if (cache.has(normalizedEmail)) {
      console.log(`[contacts] Cache hit — already seeded: ${normalizedEmail}`);
      return { status: "EXISTS" };
    }

    // ── 2. Not in cache → scan actual contacts ───────────
    const existingEmails = await _loadAllContactEmails(token);

    if (existingEmails.has(normalizedEmail)) {
      console.log(`[contacts] Already in contacts: ${normalizedEmail}`);
      cache.add(normalizedEmail);
      await _saveSeededCache(cache);
      return { status: "EXISTS" };
    }

    // ── 3. Not found — create ────────────────────────────
    console.log(`[contacts] Creating contact: ${normalizedEmail}`);
    const created = await _createContact(normalizedEmail, normalizedName, token);
    cache.add(normalizedEmail);
    await _saveSeededCache(cache);
    return { status: "CREATED", resourceName: created.resourceName };

  } catch (err) {

    console.warn(
      `[contacts] ensureCandidateContact failed (${normalizedEmail}):`,
      err.message
    );
    return { status: "FAILED", error: err.message };

  }

}


/* =========================================================
   PUBLIC: seedAllSheetCandidates
   Reads every data row from the Google Sheet and seeds
   every unique candidate email into the interviewer's
   contacts — all in one efficient pass.

   Algorithm:
     1. Fetch all Sheet rows (one API call)
     2. Fetch all existing contacts emails (one paginated scan)
     3. Diff: Sheet emails NOT in contacts  →  create
     4. Sequential creation with small delay (rate-limit safe)

   @param {string} token   Valid OAuth token

   @returns {object}
     { status, total, created, existing, failed }
========================================================= */

async function seedAllSheetCandidates(token) {

  if (!token) {
    console.warn("[contacts] seedAllSheetCandidates: no token.");
    return { status: "FAILED", error: "No token" };
  }

  console.log("[contacts] seedAllSheetCandidates: starting...");


  // ── 1. Read entire Sheet (one API call) ─────────────────

  const range = encodeURIComponent(`${CONFIG.SHEET_NAME}!A:ZZ`);

  let rows;
  try {
    const resp = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/` +
      `${CONFIG.SPREADSHEET_ID}/values/${range}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json"
        }
      }
    );
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`Sheets API ${resp.status}: ${txt}`);
    }
    const data = await resp.json();
    rows = data.values || [];
  } catch (err) {
    console.warn("[contacts] Sheet read failed:", err.message);
    return { status: "FAILED", error: err.message };
  }

  if (rows.length < 2) {
    console.log("[contacts] No data rows in sheet.");
    return { status: "DONE", total: 0, created: 0, existing: 0, failed: 0 };
  }


  // ── 2. Find EMAIL and NAME column indexes ────────────────

  const headers  = rows[0].map(h => (h || "").trim().toLowerCase());
  const emailCol = headers.indexOf((CONFIG.COLUMNS.EMAIL || "").toLowerCase());
  const nameCol  = headers.indexOf((CONFIG.COLUMNS.NAME  || "").toLowerCase());

  if (emailCol === -1) {
    console.warn(`[contacts] Column "${CONFIG.COLUMNS.EMAIL}" not found.`);
    return { status: "FAILED", error: "EMAIL column not found" };
  }


  // ── 3. Collect unique candidate emails from Sheet ────────

  const seen = new Set();
  const allCandidates = [];

  for (let i = 1; i < rows.length; i++) {
    const row   = rows[i];
    const email = ((row[emailCol] || "").trim()).toLowerCase();
    const name  = nameCol >= 0 ? (row[nameCol] || "").trim() : "";
    if (email && !seen.has(email)) {
      seen.add(email);
      allCandidates.push({ email, name });
    }
  }

  console.log(`[contacts] ${allCandidates.length} unique emails in sheet.`);

  if (!allCandidates.length) {
    return { status: "DONE", total: 0, created: 0, existing: 0, failed: 0 };
  }


  // ── 4. Compare against local cache ──────────────────────
  //
  // CACHED = confirmed seeded in a previous run → skip entirely
  // NEW    = not in cache → need to check + maybe create
  //
  // Key optimization: if sheet unchanged since last open,
  // newCandidates = [] → returns instantly with zero API calls.

  const cache = await _loadSeededCache();

  const newCandidates = allCandidates.filter(c => !cache.has(c.email));
  const cachedCount   = allCandidates.length - newCandidates.length;

  console.log(
    `[contacts] ${cachedCount} cached (skip), ` +
    `${newCandidates.length} new to process.`
  );

  if (!newCandidates.length) {
    console.log("[contacts] All sheet emails already seeded ✅ (cache hit).");
    return {
      status:   "DONE",
      total:    allCandidates.length,
      created:  0,
      existing: cachedCount,
      failed:   0
    };
  }


  // ── 5. Scan ACTUAL contacts for only the NEW emails ──────
  //
  // Prevents duplicates for emails the interviewer already
  // had in their contacts before the extension was installed.

  const existingEmails = await _loadAllContactEmails(token);

  const toCreate  = newCandidates.filter(c => !existingEmails.has(c.email));
  const alreadyIn = newCandidates.filter(c =>  existingEmails.has(c.email));

  // Backfill cache for emails already in contacts
  for (const c of alreadyIn) cache.add(c.email);

  console.log(
    `[contacts] ${alreadyIn.length} already in contacts (backfilled), ` +
    `${toCreate.length} to create.`
  );


  // ── 6. Create missing contacts ───────────────────────────

  let created = 0;
  let failed  = 0;

  for (const { email, name } of toCreate) {
    try {
      await _createContact(email, name, token);
      cache.add(email);
      created++;
    } catch (err) {
      console.warn(`[contacts] Failed to create ${email}:`, err.message);
      failed++;
    }
    // 150 ms between creates — safe within People API quota
    if (toCreate.length > 1) {
      await new Promise(r => setTimeout(r, 150));
    }
  }


  // ── 7. Persist updated cache ─────────────────────────────

  await _saveSeededCache(cache);


  const summary = {
    status:   "DONE",
    total:    allCandidates.length,
    created,
    existing: cachedCount + alreadyIn.length,
    failed
  };

  console.log("[contacts] Bulk seed complete:", summary);
  return summary;

}

