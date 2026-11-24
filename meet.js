const MEET_API_BASE =
  CONFIG.MEET.API_BASE_URL;

const PEOPLE_API_BASE =
  CONFIG.MEET.PEOPLE_API_BASE_URL;


/* =========================================================
   AUTH
========================================================= */

async function getGoogleAccessToken(
  interactive = true
) {
  try {
    const token = await new Promise(
      (resolve, reject) => {
        chrome.identity.getAuthToken(
          {
            interactive
          },
          (result) => {
            if (
              chrome.runtime.lastError
            ) {
              reject(
                new Error(
                  chrome.runtime.lastError.message
                )
              );
              return;
            }

            const tokenVal =
              typeof result === "object" && result?.token
                ? result.token
                : result;

            if (!tokenVal) {
              reject(
                new Error(
                  "Google authentication token was not available."
                )
              );
              return;
            }

            resolve(tokenVal);
          }
        );
      }
    );

    if (token) {
      try {
        await chrome.storage.local.set({ lastAuthToken: token });
      } catch (_) { }
    }

    return token;
  } catch (error) {
    if (!interactive) {
      try {
        const stored = await chrome.storage.local.get("lastAuthToken");
        if (stored && stored.lastAuthToken) {
          console.log("Using cached lastAuthToken from storage for background request.");
          return stored.lastAuthToken;
        }
      } catch (_) { }
    }

    throw error;
  }
}


/* =========================================================
   GENERIC GOOGLE API REQUEST
========================================================= */

async function googleApiRequest(
  url,
  options = {},
  interactive = true
) {

  let token =
    await getGoogleAccessToken(
      interactive
    );


  let response =
    await fetch(
      url,
      {
        ...options,

        headers: {
          ...(options.headers || {}),

          Authorization:
            `Bearer ${token}`,

          Accept:
            "application/json",

          "Content-Type":
            "application/json"
        }
      }
    );


  // Auto-refresh stale token on 401 Unauthorized
  if (response.status === 401) {
    console.warn(
      "Received 401 Unauthorized. Clearing cached token and retrying with fresh token..."
    );

    await new Promise(resolve =>
      chrome.identity.removeCachedAuthToken(
        { token },
        resolve
      )
    );

    try {
      await chrome.storage.local.remove("lastAuthToken");
    } catch (_) { }

    token =
      await getGoogleAccessToken(
        interactive
      );

    response =
      await fetch(
        url,
        {
          ...options,

          headers: {
            ...(options.headers || {}),

            Authorization:
              `Bearer ${token}`,

            Accept:
              "application/json",

            "Content-Type":
              "application/json"
          }
        }
      );
  }


  if (!response.ok) {

    const text =
      await response.text();

    throw new Error(
      `Google API ${response.status}: ${text}`
    );

  }


  if (
    response.status === 204
  ) {

    return {};

  }


  return response.json();

}


/* =========================================================
   SLEEP / RETRY HELPER
========================================================= */

function sleep(ms) {

  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );

}


/* =========================================================
   MEETING CODE
========================================================= */

function extractMeetingCode(
  meetUrl
) {

  if (!meetUrl) {

    throw new Error(
      "Interview Meet URL is missing."
    );

  }


  let url;

  try {

    url =
      new URL(meetUrl);

  } catch (error) {

    throw new Error(
      "Interview Meet URL is invalid."
    );

  }


  if (
    url.hostname.toLowerCase() !==
    "meet.google.com"
  ) {

    throw new Error(
      "The interview link is not a Google Meet URL."
    );

  }


  const parts =
    url.pathname
      .split("/")
      .filter(Boolean);


  if (!parts.length) {

    throw new Error(
      "Could not find the Meet meeting code."
    );

  }


  return parts[0].toLowerCase();

}


/* =========================================================
   GET MEET SPACE
========================================================= */

async function getMeetingSpace(
  meetingCode,
  interactive = true
) {

  const url =
    `${MEET_API_BASE}/spaces/` +
    `${encodeURIComponent(meetingCode)}`;


  console.log(
    "Getting Meet space:",
    url
  );


  return googleApiRequest(
    url,
    {},
    interactive
  );

}


/* =========================================================
   GET MEET SPACE MEMBERS (v2beta spaces.members.list)
========================================================= */

async function getSpaceMembers(
  spaceName,
  interactive = true
) {
  if (!spaceName) return [];
  try {
    const url =
      `https://meet.googleapis.com/v2beta/${spaceName}/members`;

    console.log(
      "Checking Meet space members:",
      url
    );

    const data =
      await googleApiRequest(
        url,
        {},
        interactive
      );

    console.log(
      "Meet space members response:",
      data
    );

    return data.members || [];
  } catch (err) {
    console.log(
      "Could not read Meet space members:",
      err.message
    );
    return [];
  }
}


/* =========================================================
   GET CONFERENCE RECORD FOR THIS EXACT MEET
========================================================= */

async function getConferenceRecord(
  meetingCode,
  interactive = true
) {

  console.log(
    "=== Finding Correct Meet Conference ==="
  );

  console.log(
    "Meeting code:",
    meetingCode
  );


  /* -----------------------------------------------------
     STEP 1: GET EXACT MEET SPACE
  ----------------------------------------------------- */

  let space = null;

  try {

    space =
      await getMeetingSpace(
        meetingCode,
        interactive
      );

    console.log(
      "Meet space:",
      space
    );

  } catch (error) {

    console.warn(
      "Could not resolve Meet space directly.",
      error
    );

  }


  /* -----------------------------------------------------
     STEP 2: ACTIVE CONFERENCE
  ----------------------------------------------------- */

  if (
    space &&
    space.activeConference &&
    space.activeConference.conferenceRecord
  ) {

    const conferenceName =
      space
        .activeConference
        .conferenceRecord;


    console.log(
      "Active conference:",
      conferenceName
    );


    /*
     * IMPORTANT:
     *
     * Do NOT call:
     *
     * GET /conferenceRecords/{id}
     *
     * because that was returning 403.
     *
     * The resource name itself is sufficient for:
     *
     * /participants
     * /participantSessions
     */

    return {
      name: conferenceName,
      spaceName: space?.name || null
    };

  }


  /* -----------------------------------------------------
     STEP 3: FALLBACK TO CONFERENCE LIST
  ----------------------------------------------------- */

  console.log(
    "No active conference found. " +
    "Searching conference records for exact meeting code."
  );


  let pageToken =
    null;

  const records =
    [];


  do {

    const params =
      new URLSearchParams();


    params.set(
      "filter",
      `space.meeting_code = "${meetingCode}"`
    );


    params.set(
      "pageSize",
      "100"
    );


    if (pageToken) {

      params.set(
        "pageToken",
        pageToken
      );

    }


    const url =
      `${MEET_API_BASE}/conferenceRecords?` +
      `${params.toString()}`;


    console.log(
      "Conference list URL:",
      url
    );


    const data =
      await googleApiRequest(
        url,
        {},
        interactive
      );


    records.push(
      ...(data.conferenceRecords || [])
    );


    pageToken =
      data.nextPageToken ||
      null;


  } while (pageToken);


  console.log(
    "Matching conference records:",
    records.length
  );


  if (!records.length) {

    return null;

  }


  /* -----------------------------------------------------
     STEP 4: NEWEST MATCHING CONFERENCE
  ----------------------------------------------------- */

  records.sort(
    (a, b) =>
      new Date(
        b.startTime || 0
      ) -
      new Date(
        a.startTime || 0
      )
  );


  const conference =
    records[0];


  console.log(
    "Selected conference:",
    conference
  );


  return {
    ...conference,
    spaceName: space?.name || null
  };

}


/* =========================================================
   GET ALL PARTICIPANTS
========================================================= */

async function getAllParticipants(
  conferenceName,
  interactive = true
) {

  if (!conferenceName) {

    throw new Error(
      "Conference name is missing."
    );

  }


  let participants =
    [];

  let pageToken =
    null;


  do {

    const params =
      new URLSearchParams();


    params.set(
      "pageSize",
      "250"
    );


    if (pageToken) {

      params.set(
        "pageToken",
        pageToken
      );

    }


    const url =
      `${MEET_API_BASE}/` +
      `${conferenceName}/participants?` +
      `${params.toString()}`;


    const data =
      await googleApiRequest(
        url,
        {},
        interactive
      );


    participants.push(
      ...(data.participants || [])
    );


    pageToken =
      data.nextPageToken ||
      null;


  } while (pageToken);


  console.log(
    "Total Meet participants:",
    participants.length
  );


  return participants;

}


/* =========================================================
   PEOPLE API - PARTICIPANT EMAIL
========================================================= */

const personEmailCache = new Map();

async function getPersonEmailFromMeetUser(
  meetUserResource,
  interactive = true,
  participant = null
) {

  if (!meetUserResource) {
    return null;
  }

  const userId =
    meetUserResource
      .split("/")
      .pop();

  if (!userId) {
    return null;
  }

  if (personEmailCache.has(userId)) {
    const cached = personEmailCache.get(userId);
    if (cached) return cached;
  }

  const numericId =
    String(userId).replace(/^users\//, '').replace(/^people\//, '').trim();

  const url =
    `${PEOPLE_API_BASE}/people/${numericId}?personFields=names,emailAddresses,metadata&sources=READ_SOURCE_TYPE_PROFILE&sources=READ_SOURCE_TYPE_CONTACT&sources=READ_SOURCE_TYPE_OTHER_CONTACT`;

  try {
    const token = await getGoogleAccessToken(interactive);
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json"
      }
    });

    const status = response.status;
    const headersObj = {};
    for (const [k, v] of response.headers.entries()) {
      if (["content-type", "google-cloud-resource-prefix", "server", "date", "vary"].includes(k.toLowerCase())) {
        headersObj[k] = v;
      }
    }

    const textBody = await response.text();
    let person = null;
    try {
      person = JSON.parse(textBody);
    } catch (_) { }

    let sessions = [];
    if (participant?.name) {
      try {
        sessions = await getParticipantSessions(participant.name, interactive);
      } catch (_) { }
    }

    console.log("=== DIAGNOSTIC: PEOPLE API PARTICIPANT RESOLUTION ===");
    console.log("Meet Participant Object:", participant);
    console.log("Participant User Resource:", meetUserResource);
    console.log("Participant Sessions Resource:", sessions);
    console.log("People API Endpoint:", url);
    console.log("HTTP Status:", status, response.statusText);
    console.log("Response Headers:", headersObj);
    console.log("Response Body:", textBody);
    console.log("Returned emailAddresses:", person?.emailAddresses || []);
    console.log("====================================================");

    if (!response.ok) {
      return null;
    }

    const emails = person?.emailAddresses || [];
    const email =
      emails
        .map(item => (item.value || "").trim().toLowerCase())
        .find(Boolean) || null;

    if (email) {
      personEmailCache.set(userId, email);
      console.log(
        `Resolved Meet user ${meetUserResource} -> email: ${email}`
      );
      return email;
    }
  } catch (err) {
    console.warn(`Error resolving participant email for ${meetUserResource}:`, err.message);
  }

  return null;
}


/* =========================================================
   CURRENT GOOGLE ACCOUNT EMAIL
========================================================= */

async function getCurrentUserEmail(
  interactive = true
) {

  const url =
    `${PEOPLE_API_BASE}/people/me` +
    `?personFields=emailAddresses`;


  const person =
    await googleApiRequest(
      url,
      {},
      interactive
    );


  const emails =
    person.emailAddresses ||
    [];


  if (!emails.length) {

    throw new Error(
      "Could not determine current Google account email."
    );

  }


  const email =
    (
      emails[0].value ||
      ""
    )
      .trim()
      .toLowerCase();


  if (!email) {

    throw new Error(
      "Could not determine current Google account email."
    );

  }


  console.log(
    "Current Google account email:",
    email
  );


  return email;

}


/* =========================================================
   CURRENT GOOGLE ACCOUNT PROFILE (EMAIL + USER ID)
========================================================= */

async function getCurrentUserProfile(
  interactive = true
) {
  // Method 0: Check chrome.storage.local for cached interviewer profile
  try {
    const stored = await chrome.storage.local.get("interviewerProfile");
    if (stored?.interviewerProfile?.email || stored?.interviewerProfile?.userId) {
      console.log(
        "Current Google account resolved via chrome.storage.local:",
        stored.interviewerProfile
      );
      return stored.interviewerProfile;
    }
  } catch (storageErr) {
    console.warn("Could not read interviewerProfile from storage:", storageErr);
  }

  // Method 1: Google OAuth2 UserInfo (Standard, guaranteed to work with userinfo.email scope)
  try {
    const userInfo =
      await googleApiRequest(
        "https://www.googleapis.com/oauth2/v2/userinfo",
        {},
        interactive
      );

    if (userInfo && (userInfo.email || userInfo.id)) {
      const email =
        (userInfo.email || "").trim().toLowerCase();
      const userId =
        userInfo.id || null;
      const name =
        (userInfo.name || "").trim();

      const profile = { email, userId, name };
      console.log(
        "Current Google account resolved via oauth2 userinfo:",
        profile
      );

      // Cache for future background runs
      chrome.storage.local.set({ interviewerProfile: profile }).catch(() => { });

      return profile;
    }
  } catch (oauthErr) {
    console.warn(
      "Could not fetch oauth2/v2/userinfo:",
      oauthErr.message
    );
  }

  // Method 2: Google People API (people/me)
  try {
    const url =
      `${PEOPLE_API_BASE}/people/me` +
      `?personFields=emailAddresses,metadata,names`;

    const person =
      await googleApiRequest(
        url,
        {},
        interactive
      );

    const emails =
      person.emailAddresses || [];

    const email =
      (emails[0]?.value || "").trim().toLowerCase();

    let userId = null;
    if (person.resourceName) {
      userId = person.resourceName.replace("people/", "");
    } else if (person.metadata?.sources?.[0]?.id) {
      userId = person.metadata.sources[0].id;
    }

    const name =
      person.names?.[0]?.displayName || null;

    const profile = { email, userId, name };
    console.log(
      "Current Google account resolved via People API:",
      profile
    );

    chrome.storage.local.set({ interviewerProfile: profile }).catch(() => { });

    return profile;
  } catch (peopleErr) {
    console.warn(
      "Could not fetch people/me:",
      peopleErr.message
    );
  }

  // Method 3: chrome.identity.getProfileUserInfo (Chrome Profile Fallback)
  return new Promise(resolve => {
    if (chrome.identity && chrome.identity.getProfileUserInfo) {
      chrome.identity.getProfileUserInfo(profileInfo => {
        const email =
          (profileInfo?.email || "").trim().toLowerCase();
        const userId =
          profileInfo?.id || null;

        const profile = { email, userId, name: null };
        console.log(
          "Current Google account resolved via Chrome identity:",
          profile
        );

        if (profile.email || profile.userId) {
          chrome.storage.local.set({ interviewerProfile: profile }).catch(() => { });
        }

        resolve(profile);
      });
    } else {
      resolve({ email: null, userId: null, name: null });
    }
  });
}


/* =========================================================
   PARTICIPANT EMAIL MAP
========================================================= */

async function buildParticipantEmailMap(
  participants,
  interactive = true,
  spaceName = null
) {

  const map =
    [];

  // Method 1: Check Google Meet Space Members (spaces/{space}/members returns user <-> email)
  if (spaceName) {
    try {
      const spaceMembers = await getSpaceMembers(spaceName, interactive);
      if (spaceMembers.length) {
        console.log("Found Meet space members:", spaceMembers);
        for (const m of spaceMembers) {
          if (m.user && m.email) {
            const p = participants.find(
              item => item.signedinUser?.user === m.user
            );
            if (p) {
              const email = m.email.trim().toLowerCase();
              console.log(`Resolved Meet user ${m.user} via Meet Space Member -> email: ${email}`);
              map.push({ participant: p, email });
            }
          }
        }
      }
    } catch (e) {
      console.log("Could not resolve via space members:", e.message);
    }
  }

  // Method 2: People API resolution for any participants not yet mapped
  for (
    const participant
    of participants
  ) {

    if (
      !participant.signedinUser ||
      !participant.signedinUser.user
    ) {

      continue;

    }

    if (map.some(item => item.participant?.name === participant.name)) {
      continue;
    }


    const email =
      await getPersonEmailFromMeetUser(
        participant.signedinUser.user,
        interactive,
        participant
      );


    if (!email) {

      console.log(
        "Participant email not in People API directory for:",
        participant.signedinUser.user
      );

      continue;

    }


    map.push({
      participant,
      email
    });

  }


  console.log(
    "Resolved participant email map:",
    map
  );


  return map;

}


/* =========================================================
   PARTICIPANT SESSIONS
========================================================= */

async function getParticipantSessions(
  participantName,
  interactive = true
) {

  if (!participantName) {

    return [];

  }


  let sessions =
    [];

  let pageToken =
    null;


  do {

    const params =
      new URLSearchParams();


    params.set(
      "pageSize",
      "250"
    );


    if (pageToken) {

      params.set(
        "pageToken",
        pageToken
      );

    }


    const url =
      `${MEET_API_BASE}/` +
      `${participantName}/participantSessions?` +
      `${params.toString()}`;


    const data =
      await googleApiRequest(
        url,
        {},
        interactive
      );


    sessions.push(
      ...(data.participantSessions || [])
    );


    pageToken =
      data.nextPageToken ||
      null;


  } while (pageToken);


  sessions.sort(
    (a, b) =>
      new Date(
        a.startTime || 0
      ) -
      new Date(
        b.startTime || 0
      )
  );


  console.log(
    "Participant sessions:",
    participantName,
    sessions
  );


  return sessions;

}


/* =========================================================
   BUILD PARTICIPANT TIMELINE
========================================================= */

async function getParticipantTimeline(
  participant,
  interactive = true
) {

  if (
    !participant ||
    !participant.name
  ) {

    return {
      joinTime: null,
      leaveTime: null,
      sessions: []
    };

  }


  let sessions =
    [];


  try {

    sessions =
      await getParticipantSessions(
        participant.name,
        interactive
      );

  } catch (error) {

    console.warn(
      "Could not retrieve participant sessions. " +
      "Using aggregate participant timestamps.",
      participant.name,
      error
    );

  }


  if (!sessions.length) {

    return {

      joinTime:
        participant.earliestStartTime ||
        null,

      leaveTime:
        participant.latestEndTime ||
        null,

      sessions: []

    };

  }


  const firstSession =
    sessions[0];

  const lastSession =
    sessions[sessions.length - 1];

  // If the last session has no endTime, participant is STILL IN THE CALL!
  const isStillInCall = !lastSession.endTime;

  return {
    joinTime:
      firstSession.startTime ||
      participant.earliestStartTime ||
      null,

    leaveTime:
      isStillInCall
        ? null
        : (lastSession.endTime || participant.latestEndTime || null),

    sessions
  };

}


/* =========================================================
   INTERVIEW TIMELINE - 1:1
========================================================= */

/*
 * CURRENT SCOPE:
 *
 * Only these four timestamps are returned:
 *
 *   interviewerJoinTime
 *   interviewerLeaveTime
 *   candidateJoinTime
 *   candidateLeaveTime
 *
 *
 * 1:1 rules:
 *
 * BOTH JOIN
 *   -> candidate identified by email
 *   -> other participant = interviewer
 *
 * ONLY CANDIDATE
 *   -> candidate timestamps populated
 *   -> interviewer timestamps null
 *
 * ONLY INTERVIEWER
 *   -> interviewer timestamps populated
 *   -> candidate timestamps null
 *
 * NOBODY
 *   -> all timestamps null
 *
 *
 * We do NOT calculate:
 *
 *   Candidate Waiting Time
 *   Interview Duration
 */


/**
 * Extract display name safely from participant
 */
function getParticipantDisplayName(p) {
  if (!p) return "";
  return (
    p.signedinUser?.displayName ||
    p.anonymousUser?.displayName ||
    p.phoneUser?.displayName ||
    ""
  ).trim();
}

/* =========================================================
   CREATE DEDICATED MEET SPACE (POST /v2/spaces)
========================================================= */

async function createDedicatedInterviewSpace(
  interactive = true
) {
  const url = `${MEET_API_BASE}/spaces`;

  console.log(
    "Creating dedicated Google Meet space:",
    url
  );

  const data =
    await googleApiRequest(
      url,
      {
        method: "POST",
        body: JSON.stringify({
          config: {
            accessType: "OPEN"
          }
        })
      },
      interactive
    );

  console.log(
    "Created dedicated Meet space:",
    data
  );

  return {
    spaceName: data.name,
    meetingUri: data.meetingUri,
    meetingCode: data.meetingCode
  };
}








/* =========================================================
   GET INTERVIEW TIMELINE
========================================================= */

async function getInterviewTimeline(
  meetUrl,
  candidateEmail,
  interactive = true,
  knownInterviewer = null,
  candidateName = null
) {

  const normalizedCandidateEmail =
    (
      candidateEmail ||
      ""
    )
      .trim()
      .toLowerCase();


  if (!normalizedCandidateEmail) {

    throw new Error(
      "Candidate email is missing from the Sheet."
    );

  }


  console.log(
    "=========================================="
  );

  console.log(
    "INTERVIEW TIMELINE COLLECTION"
  );

  console.log(
    "Meet URL:",
    meetUrl
  );

  console.log(
    "Candidate email:",
    normalizedCandidateEmail
  );


  /* -----------------------------------------------------
     0. ENSURE CANDIDATE IS IN GOOGLE CONTACTS
     If not yet in contacts, ensure they are added so
     People API can resolve their email during the Meet.
  ----------------------------------------------------- */

  if (normalizedCandidateEmail && typeof ensureCandidateContact === "function") {
    try {
      const contactsToken = await getGoogleAccessToken(interactive);
      if (contactsToken) {
        await ensureCandidateContact(
          normalizedCandidateEmail,
          candidateName || "",
          contactsToken
        );
      }
    } catch (contactErr) {
      console.warn("[meet] Candidate contact check notice:", contactErr.message);
    }
  }


  /* -----------------------------------------------------
     1. GET MEETING CODE
  ----------------------------------------------------- */

  const meetingCode =
    extractMeetingCode(
      meetUrl
    );


  console.log(
    "Meeting code:",
    meetingCode
  );


  /* -----------------------------------------------------
     2. GET EXACT CONFERENCE
  ----------------------------------------------------- */

  const conference =
    await getConferenceRecord(
      meetingCode,
      interactive
    );


  if (!conference) {

    console.log(
      "No conference found yet."
    );

    return null;

  }


  console.log(
    "Selected conference:",
    conference
  );


  /* -----------------------------------------------------
     3. GET PARTICIPANTS
  ----------------------------------------------------- */

  const participants =
    await getAllParticipants(
      conference.name,
      interactive
    );


  console.log(
    "Participants:",
    participants
  );


  if (!participants.length) {

    console.log(
      "No participants found yet."
    );


    return {

      interviewerJoinTime:
        null,

      interviewerLeaveTime:
        null,

      candidateJoinTime:
        null,

      candidateLeaveTime:
        null,

      complete:
        Boolean(conference.endTime)

    };

  }


  /* -----------------------------------------------------
     4. RESOLVE PARTICIPANT EMAILS VIA PEOPLE API
  ----------------------------------------------------- */

  const participantEmailMap =
    await buildParticipantEmailMap(
      participants,
      interactive,
      conference.spaceName
    );


  console.log(
    "Participant email map:",
    participantEmailMap
  );


  /* -----------------------------------------------------
     5. IDENTIFY INTERVIEWER FIRST
  ----------------------------------------------------- */

  let currentUser =
    knownInterviewer && (knownInterviewer.email || knownInterviewer.userId)
      ? knownInterviewer
      : null;

  if (!currentUser) {
    try {
      currentUser =
        await getCurrentUserProfile(
          interactive
        );
    } catch (err) {
      console.warn(
        "Could not fetch current user profile:",
        err
      );
    }
  }

  const normalizedInterviewerEmail =
    (currentUser?.email || "").trim().toLowerCase();
  const interviewerUserId =
    currentUser?.userId ? String(currentUser.userId).trim() : null;
  const interviewerName =
    (currentUser?.name || "").trim().toLowerCase();

  console.log("Interviewer target profile:", {
    email: normalizedInterviewerEmail,
    userId: interviewerUserId,
    name: interviewerName
  });

  let interviewerParticipant = null;

  // 1. Match interviewer by resolved email
  if (normalizedInterviewerEmail) {
    const interviewerEntry =
      participantEmailMap.find(
        item => item.email === normalizedInterviewerEmail
      );
    if (interviewerEntry) {
      interviewerParticipant = interviewerEntry.participant;
    }
  }

  // 2. Match interviewer by Google User ID
  if (!interviewerParticipant && interviewerUserId) {
    interviewerParticipant =
      participants.find(
        p =>
          p.signedinUser?.user === `users/${interviewerUserId}` ||
          p.signedinUser?.user?.endsWith(`/${interviewerUserId}`)
      ) || null;
  }

  // 3. Match interviewer by Google Display Name
  if (!interviewerParticipant && interviewerName) {
    interviewerParticipant =
      participants.find(
        p =>
          p.signedinUser?.displayName &&
          p.signedinUser.displayName.trim().toLowerCase() === interviewerName
      ) || null;
  }

  if (interviewerParticipant) {
    console.log(
      "Interviewer identified ✅:",
      getParticipantDisplayName(interviewerParticipant) || interviewerParticipant.name
    );
  }



  /* -----------------------------------------------------
     6. IDENTIFY CANDIDATE — EMAIL-EXACT MATCH
     Only a participant whose People-API-resolved email
     exactly matches the Sheet candidate email is accepted.
     Any 3rd/4th person in the call is ignored entirely.
     If the contact hasn't propagated yet, candidateParticipant
     is null — timestamps stay blank, monitor retries next alarm.
  ----------------------------------------------------- */

  const candidateEntry =
    participantEmailMap.find(
      item =>
        item.email === normalizedCandidateEmail &&
        item.participant?.name !== interviewerParticipant?.name
    );

  const candidateParticipant =
    candidateEntry?.participant || null;

  if (candidateParticipant) {
    console.log(
      "[Candidate] Email-exact match ✅:",
      normalizedCandidateEmail,
      "→",
      getParticipantDisplayName(candidateParticipant) || candidateParticipant.name
    );
  } else {
    console.log(
      "[Candidate] No email match found for:",
      normalizedCandidateEmail,
      "— will remain blank until contact propagates."
    );
  }


  /* -----------------------------------------------------
     6C. VERIFICATION SUMMARY
  ----------------------------------------------------- */

  console.log("=== PARTICIPANT MATCH VERIFICATION ===");
  console.log(
    "Candidate verified:",
    candidateParticipant
      ? (getParticipantDisplayName(candidateParticipant) || candidateParticipant.name)
      : "NO (will remain blank)"
  );
  console.log(
    "Interviewer verified:",
    interviewerParticipant
      ? (getParticipantDisplayName(interviewerParticipant) || interviewerParticipant.name)
      : "NO (will remain blank)"
  );
  console.log("Total Meet participants:", participants.length);


  /* -----------------------------------------------------
     7. GET CANDIDATE TIMELINE
  ----------------------------------------------------- */

  let candidateTimeline = {
    joinTime: null,
    leaveTime: null,
    sessions: []
  };

  if (candidateParticipant) {
    candidateTimeline =
      await getParticipantTimeline(
        candidateParticipant,
        interactive
      );
  }


  /* -----------------------------------------------------
     8. GET INTERVIEWER TIMELINE
  ----------------------------------------------------- */

  let interviewerTimeline = {
    joinTime: null,
    leaveTime: null,
    sessions: []
  };

  if (interviewerParticipant) {
    interviewerTimeline =
      await getParticipantTimeline(
        interviewerParticipant,
        interactive
      );
  }


  /* -----------------------------------------------------
     9. CHECK CONFERENCE COMPLETION
  ----------------------------------------------------- */

  const conferenceEnded =
    Boolean(
      conference.endTime
    );


  /* -----------------------------------------------------
     10. EXTRACT FOUR REQUIRED TIMESTAMPS
  ----------------------------------------------------- */

  let interviewerJoinTime =
    interviewerParticipant
      ? (interviewerTimeline.joinTime || interviewerParticipant.earliestStartTime || null)
      : null;

  let interviewerLeaveTime =
    interviewerParticipant
      ? interviewerTimeline.leaveTime
      : null;

  // Finalize leave time if meeting has concluded
  if (conferenceEnded && interviewerParticipant && !interviewerLeaveTime) {
    interviewerLeaveTime =
      interviewerParticipant.latestEndTime || conference.endTime || null;
  }

  let candidateJoinTime =
    candidateParticipant
      ? (candidateTimeline.joinTime || candidateParticipant.earliestStartTime || null)
      : null;

  let candidateLeaveTime =
    candidateParticipant
      ? candidateTimeline.leaveTime
      : null;

  // Finalize leave time if meeting has concluded
  if (conferenceEnded && candidateParticipant && !candidateLeaveTime) {
    candidateLeaveTime =
      candidateParticipant.latestEndTime || conference.endTime || null;
  }


  console.log(
    "Interviewer Join Time:",
    interviewerJoinTime
  );

  console.log(
    "Interviewer Leave Time:",
    interviewerLeaveTime
  );

  console.log(
    "Candidate Join Time:",
    candidateJoinTime
  );

  console.log(
    "Candidate Leave Time:",
    candidateLeaveTime
  );


  /* -----------------------------------------------------
     11. TIMELINE COMPLETION
  ----------------------------------------------------- */

  const observedTimelines =
    [
      candidateParticipant
        ? candidateTimeline
        : null,

      interviewerParticipant
        ? interviewerTimeline
        : null

    ].filter(Boolean);

  const allObservedParticipantsLeft =
    observedTimelines.length > 0 &&
    observedTimelines.every(
      timeline =>
        Boolean(
          timeline.leaveTime
        )
    );

  const complete =
    conferenceEnded &&
    (observedTimelines.length === 0 || allObservedParticipantsLeft);


  /* -----------------------------------------------------
     12. FINAL TIMELINE
  ----------------------------------------------------- */

  const timeline = {
    interviewerJoinTime,
    interviewerLeaveTime,
    candidateJoinTime,
    candidateLeaveTime,
    complete
  };

  console.log(
    "FINAL INTERVIEW TIMELINE:",
    timeline
  );

  console.log(
    "Conference ended:",
    conferenceEnded
  );

  console.log(
    "All observed participants left:",
    allObservedParticipantsLeft
  );

  console.log(
    "Timeline complete:",
    complete
  );

  console.log(
    "=========================================="
  );

  return timeline;
}