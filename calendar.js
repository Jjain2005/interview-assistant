// =====================================================
// CALENDAR.JS
// Google Calendar integration for Interview Assistant
//
// Purpose:
// 1. Find the Calendar event associated with a Meet URL.
// 2. Verify the candidate email from Google Sheets
//    against Calendar attendees.
// 3. Calendar is used for verification/corroboration.
// 4. Google Sheet remains the candidate source of truth.
// =====================================================


// =====================================================
// CONSTANTS
// =====================================================

const CALENDAR_API_BASE =
  "https://www.googleapis.com/calendar/v3";


// =====================================================
// GOOGLE ACCESS TOKEN
// =====================================================

async function getCalendarAccessToken(
  interactive = true
) {

  return new Promise(
    (resolve, reject) => {

      chrome.identity.getAuthToken(
        {
          interactive
        },
        token => {

          if (chrome.runtime.lastError) {

            reject(
              new Error(
                chrome.runtime.lastError.message
              )
            );

            return;

          }


          if (!token) {

            reject(
              new Error(
                "No Google access token available."
              )
            );

            return;

          }


          resolve(token);

        }
      );

    }
  );

}


// =====================================================
// CALENDAR API REQUEST
// =====================================================

async function calendarApiRequest(
  url,
  options = {},
  interactive = true
) {

  const token =
    await getCalendarAccessToken(
      interactive
    );


  const response =
    await fetch(
      url,
      {
        ...options,

        headers: {
          ...(options.headers || {}),

          Authorization:
            `Bearer ${token}`,

          "Content-Type":
            "application/json"
        }
      }
    );


  if (!response.ok) {

    const errorText =
      await response.text();


    throw new Error(
      `Calendar API ${response.status}: ${errorText}`
    );

  }


  return response.json();

}


// =====================================================
// NORMALIZE EMAIL
// =====================================================

function normalizeCalendarEmail(
  email
) {

  if (!email) {
    return null;
  }


  return String(email)
    .trim()
    .toLowerCase();

}


// =====================================================
// NORMALIZE MEET CODE
// =====================================================

function normalizeCalendarMeetingCode(
  code
) {

  if (!code) {
    return null;
  }


  return String(code)
    .trim()
    .toLowerCase();

}


// =====================================================
// EXTRACT MEET CODE FROM MEET URL
// =====================================================

function extractCalendarMeetingCode(
  meetUrl
) {

  if (!meetUrl) {
    return null;
  }


  try {

    const url =
      new URL(meetUrl);


    if (
      url.hostname !==
      "meet.google.com"
    ) {

      return null;

    }


    const parts =
      url.pathname
        .split("/")
        .filter(Boolean);


    if (!parts.length) {
      return null;
    }


    return normalizeCalendarMeetingCode(
      parts[0]
    );

  } catch (error) {

    console.warn(
      "Unable to extract Calendar meeting code:",
      error
    );


    return null;

  }

}


// =====================================================
// GET CALENDAR CONFERENCE ID
//
// Google Calendar stores the Google Meet meeting code
// in:
//
// event.conferenceData.conferenceId
// =====================================================

function getCalendarConferenceId(
  event
) {

  if (!event) {
    return null;
  }


  return normalizeCalendarMeetingCode(
    event
      .conferenceData
      ?.conferenceId
  );

}


// =====================================================
// GET ATTENDEE EMAILS
// =====================================================

function getCalendarAttendeeEmails(
  event
) {

  if (
    !event ||
    !Array.isArray(event.attendees)
  ) {

    return [];

  }


  return event.attendees
    .map(
      attendee =>
        normalizeCalendarEmail(
          attendee.email
        )
    )
    .filter(Boolean);

}


// =====================================================
// GET CALENDAR EVENTS
//
// IMPORTANT:
//
// This does NOT use ±24 hours.
//
// It walks through the Calendar API pages and
// retrieves the available events from the calendar.
//
// Calendar API is paginated, so one request is not
// enough when there are many events.
// =====================================================

async function getAllCalendarEvents(
  interactive = true
) {

  const events = [];

  let pageToken = null;


  do {

    const params =
      new URLSearchParams({

        singleEvents:
          "true",

        maxResults:
          "2500"

      });


    if (pageToken) {

      params.set(
        "pageToken",
        pageToken
      );

    }


    const url =
      `${CALENDAR_API_BASE}` +
      `/calendars/primary/events?` +
      params.toString();


    console.log(
      "Fetching Calendar events:",
      pageToken
        ? "next page"
        : "first page"
    );


    const data =
      await calendarApiRequest(
        url,
        {},
        interactive
      );


    if (
      Array.isArray(data.items)
    ) {

      events.push(
        ...data.items
      );

    }


    pageToken =
      data.nextPageToken ||
      null;


  } while (pageToken);


  console.log(
    `Total Calendar events retrieved: ${events.length}`
  );


  return events;

}


// =====================================================
// FIND CALENDAR EVENT FOR MEET
//
// Matching strategy:
//
// Sheet Meet URL
//      ↓
// Meet code
//      ↓
// Calendar conferenceData.conferenceId
//
// No date restriction.
// No ±24 hour restriction.
// =====================================================

async function findCalendarEventForMeet(
  meetUrl,
  interactive = true
) {

  const meetingCode =
    extractCalendarMeetingCode(
      meetUrl
    );


  if (!meetingCode) {

    throw new Error(
      "Invalid Google Meet URL."
    );

  }


  console.log(
    "=========================================="
  );


  console.log(
    "CALENDAR MEET SEARCH"
  );


  console.log(
    "Meet URL:",
    meetUrl
  );


  console.log(
    "Meet code:",
    meetingCode
  );


  console.log(
    "Searching entire Calendar event list..."
  );


  const events =
    await getAllCalendarEvents(
      interactive
    );


  console.log(
    `Calendar returned ${events.length} events.`
  );


  // ---------------------------------------------------
  // Find events whose Google Meet conference ID
  // matches the Meet code from the Sheet.
  // ---------------------------------------------------

  const matchingEvents =
    events.filter(
      event =>
        getCalendarConferenceId(event) ===
        meetingCode
    );


  if (!matchingEvents.length) {

    console.log(
      "No Calendar event found for Meet code:",
      meetingCode
    );


    return null;

  }


  console.log(
    `Found ${matchingEvents.length} Calendar event(s) ` +
    `for Meet code ${meetingCode}.`
  );


  // ---------------------------------------------------
  // Usually there should only be one event.
  //
  // If multiple events somehow use the same Meet code,
  // choose the most recently updated one.
  // ---------------------------------------------------

  matchingEvents.sort(
    (a, b) => {

      const aUpdated =
        new Date(
          a.updated || 0
        ).getTime();


      const bUpdated =
        new Date(
          b.updated || 0
        ).getTime();


      return bUpdated - aUpdated;

    }
  );


  const event =
    matchingEvents[0];


  console.log(
    "Calendar event matched:",
    {
      id:
        event.id,

      summary:
        event.summary,

      status:
        event.status,

      conferenceId:
        getCalendarConferenceId(event),

      attendees:
        getCalendarAttendeeEmails(
          event
        ),

      updated:
        event.updated
    }
  );


  console.log(
    "=========================================="
  );


  return event;

}


// =====================================================
// RESOLVE / VERIFY CANDIDATE FROM CALENDAR
//
// Sheet provides candidateEmail.
//
// Calendar provides attendees.
//
// We DO NOT replace the Sheet email with Calendar data.
//
// Calendar only verifies whether the Sheet candidate
// appears as an attendee of the scheduled event.
// =====================================================

async function resolveCandidateFromCalendar(
  meetUrl,
  sheetCandidateEmail,
  interactive = true
) {

  const normalizedCandidateEmail =
    normalizeCalendarEmail(
      sheetCandidateEmail
    );


  if (!normalizedCandidateEmail) {

    throw new Error(
      "Candidate email is required."
    );

  }


  console.log(
    "Candidate email from Sheet:",
    normalizedCandidateEmail
  );


  const event =
    await findCalendarEventForMeet(
      meetUrl,
      interactive
    );


  // ---------------------------------------------------
  // Calendar event not found
  // ---------------------------------------------------

  if (!event) {

    return {

      found:
        false,

      verified:
        false,

      reason:
        "calendar_event_not_found",

      event:
        null,

      candidateEmail:
        normalizedCandidateEmail,

      attendeeEmails:
        []

    };

  }


  // ---------------------------------------------------
  // Get Calendar attendees
  // ---------------------------------------------------

  const attendeeEmails =
    getCalendarAttendeeEmails(
      event
    );


  console.log(
    "Calendar attendee emails:",
    attendeeEmails
  );


  // ---------------------------------------------------
  // Check Sheet candidate against Calendar attendees
  // ---------------------------------------------------

  const candidateFound =
    attendeeEmails.includes(
      normalizedCandidateEmail
    );


  if (!candidateFound) {

    console.warn(
      "Candidate from Sheet is NOT a Calendar attendee:",
      normalizedCandidateEmail
    );


    return {

      found:
        false,

      verified:
        false,

      reason:
        "candidate_not_calendar_attendee",

      event,

      candidateEmail:
        normalizedCandidateEmail,

      attendeeEmails

    };

  }


  // ---------------------------------------------------
  // Candidate verified
  // ---------------------------------------------------

  console.log(
    "Calendar candidate verified:",
    normalizedCandidateEmail
  );


  return {

    found:
      true,

    verified:
      true,

    reason:
      "candidate_verified",

    event,

    candidateEmail:
      normalizedCandidateEmail,

    attendeeEmails

  };

}