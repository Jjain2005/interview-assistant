// =====================================================
// IMPORT CONFIG / MEET / CALENDAR / SHEETS
// =====================================================

importScripts(
  "config.js",
  "contacts.js",
  "meet.js",
  "timestamp-writer.js"
);

// Enable side panel to open on extension icon click
if (typeof chrome !== "undefined" && chrome.sidePanel && typeof chrome.sidePanel.setPanelBehavior === "function") {
  chrome.sidePanel.setPanelBehavior({
    openPanelOnActionClick: true
  }).catch(error => console.error("Side panel behavior error:", error));
}


// =====================================================
// ALARM NAMES
// =====================================================

const TIMELINE_MONITOR_ALARM =
  "interview-timeline-monitor";

const LEGACY_RETRY_ALARM =
  "interview-timestamp-retry";


// =====================================================
// STORAGE KEY
// =====================================================

const ACTIVE_INTERVIEW_KEY =
  "activeInterviewTimeline";


// =====================================================
// MONITOR LOCK
//
// Prevents two alarm executions from calling
// Google Meet APIs at the same time.
// =====================================================

let timelineCollectionRunning =
  false;


// =====================================================
// EXTENSION INSTALLED / UPDATED
// =====================================================

chrome.runtime.onInstalled.addListener(
  async () => {

    console.log(
      "Interview Assistant installed/updated."
    );

    await restoreTimelineMonitor();

  }
);


// =====================================================
// SERVICE WORKER STARTUP
//
// Service workers can restart.
// Restore the monitor if an interview was already
// being tracked.
// =====================================================

chrome.runtime.onStartup.addListener(
  async () => {

    console.log(
      "Interview Assistant service worker started."
    );

    await restoreTimelineMonitor();

  }
);


// =====================================================
// MESSAGE HANDLER
// =====================================================

chrome.runtime.onMessage.addListener(
  (message, sender, sendResponse) => {

    if (!message || !message.type) {

      return;

    }


    /* -------------------------------------------------
       START MONITOR
    ------------------------------------------------- */

    if (
      message.type ===
      "START_INTERVIEW_MONITOR"
    ) {

      startInterviewMonitor(
        message.payload
      )
        .then(
          result =>
            sendResponse({
              success: true,
              result
            })
        )
        .catch(
          error => {

            console.error(
              "START_INTERVIEW_MONITOR error:",
              error
            );

            sendResponse({
              success: false,
              error:
                error.message
            });

          }
        );


      return true;

    }


    /* -------------------------------------------------
       STOP MONITOR
    ------------------------------------------------- */

    if (
      message.type ===
      "STOP_INTERVIEW_MONITOR"
    ) {

      stopInterviewMonitor()
        .then(
          result =>
            sendResponse({
              success: true,
              result
            })
        )
        .catch(
          error => {

            console.error(
              "STOP_INTERVIEW_MONITOR error:",
              error
            );

            sendResponse({
              success: false,
              error:
                error.message
            });

          }
        );


      return true;

    }


    /* -------------------------------------------------
       LEGACY RETRY
    ------------------------------------------------- */

    if (
      message.type ===
      "SCHEDULE_TIMESTAMP_RETRY"
    ) {

      /*
       * Old popup code may still send this message.
       *
       * Instead of creating a separate retry system,
       * convert it into the new continuous monitor.
       */

      startInterviewMonitor(
        message.payload
      )
        .then(
          result =>
            sendResponse({
              success: true,
              result
            })
        )
        .catch(
          error => {

            console.error(
              "SCHEDULE_TIMESTAMP_RETRY error:",
              error
            );

            sendResponse({
              success: false,
              error:
                error.message
            });

          }
        );


      return true;

    }

  }
);


// =====================================================
// START INTERVIEW MONITOR
// =====================================================

async function startInterviewMonitor(
  payload
) {

  if (!payload) {

    throw new Error(
      "Interview monitor payload is missing."
    );

  }


  const meetUrl =
    (
      payload.meetUrl ||
      ""
    ).trim();


  const candidateEmail =
    (
      payload.candidateEmail ||
      ""
    )
      .trim()
      .toLowerCase();


  const rowNumber =
    Number(
      payload.rowNumber
    );


  if (!meetUrl) {

    throw new Error(
      "Meet URL is missing."
    );

  }


  if (!candidateEmail) {

    throw new Error(
      "Candidate email is missing."
    );

  }


  if (
    !Number.isInteger(rowNumber) ||
    rowNumber < 2
  ) {

    throw new Error(
      "Invalid candidate Sheet row number."
    );

  }


  /* -------------------------------------------------
     Store current interview
  ------------------------------------------------- */

  const interviewerEmail =
    (payload.interviewerEmail || "").trim().toLowerCase();

  const interviewerUserId =
    payload.interviewerUserId
      ? String(payload.interviewerUserId).trim()
      : null;

  const interviewerName =
    (payload.interviewerName || "").trim();

  const candidateName =
    (payload.candidateName || "").trim();

  const activeInterview = {
    meetUrl,
    candidateEmail,
    candidateName,
    rowNumber,
    interviewerEmail,
    interviewerUserId,
    interviewerName,
    startedAt:
      Date.now()
  };

  if (payload.token) {
    try {
      await chrome.storage.local.set({
        lastAuthToken: payload.token
      });
    } catch (_) { }
  }

  await chrome.storage.local.set({
    [ACTIVE_INTERVIEW_KEY]:
      activeInterview
  });


  console.log(
    "Interview timeline monitor started:",
    activeInterview
  );


  /* -------------------------------------------------
     Remove old one-shot retry alarm
  ------------------------------------------------- */

  await chrome.alarms.clear(
    LEGACY_RETRY_ALARM
  );


  /* -------------------------------------------------
     Create continuous monitor
  ------------------------------------------------- */

  await chrome.alarms.clear(
    TIMELINE_MONITOR_ALARM
  );


  chrome.alarms.create(
    TIMELINE_MONITOR_ALARM,
    {
      delayInMinutes:
        0.5,

      periodInMinutes:
        0.5
    }
  );


  /*
   * Do not wait 30 seconds for the first check.
   * Trigger initial collection asynchronously in the background
   * so the message response returns immediately to the popup.
   */

  collectAndWriteTimeline(
    activeInterview,
    "initial"
  ).catch(error => {
    console.warn(
      "Initial background timeline check notice (will retry on alarm):",
      error
    );
  });


  return {
    started: true,
    complete:
      false
  };

}


// =====================================================
// STOP INTERVIEW MONITOR
// =====================================================

async function stopInterviewMonitor() {

  await chrome.alarms.clear(
    TIMELINE_MONITOR_ALARM
  );


  await chrome.alarms.clear(
    LEGACY_RETRY_ALARM
  );


  await chrome.storage.local.remove(
    ACTIVE_INTERVIEW_KEY
  );


  console.log(
    "Interview timeline monitor stopped."
  );


  return {
    stopped: true
  };

}


// =====================================================
// RESTORE MONITOR
// =====================================================

async function restoreTimelineMonitor() {

  try {

    const stored =
      await chrome.storage.local.get(
        ACTIVE_INTERVIEW_KEY
      );


    const activeInterview =
      stored[
      ACTIVE_INTERVIEW_KEY
      ];


    if (!activeInterview) {

      console.log(
        "No active interview monitor to restore."
      );

      return;

    }


    /*
     * Ignore malformed old storage.
     */

    if (
      !activeInterview.meetUrl ||
      !activeInterview.candidateEmail ||
      !activeInterview.rowNumber
    ) {

      console.warn(
        "Stored interview monitor data is invalid. Clearing it."
      );


      await stopInterviewMonitor();

      return;

    }


    console.log(
      "Restoring interview timeline monitor:",
      activeInterview
    );


    await chrome.alarms.clear(
      TIMELINE_MONITOR_ALARM
    );


    chrome.alarms.create(
      TIMELINE_MONITOR_ALARM,
      {
        delayInMinutes:
          0.5,

        periodInMinutes:
          0.5
      }
    );


    /*
     * Immediately attempt to recover timeline.
     */

    await collectAndWriteTimeline(
      activeInterview,
      "restore"
    );

  } catch (error) {

    console.error(
      "Could not restore timeline monitor:",
      error
    );

  }

}


// =====================================================
// ALARM HANDLER
// =====================================================

chrome.alarms.onAlarm.addListener(
  async alarm => {

    if (
      alarm.name !==
      TIMELINE_MONITOR_ALARM
    ) {

      return;

    }


    try {

      const stored =
        await chrome.storage.local.get(
          ACTIVE_INTERVIEW_KEY
        );


      const activeInterview =
        stored[
        ACTIVE_INTERVIEW_KEY
        ];


      if (!activeInterview) {

        console.log(
          "Timeline alarm fired but no active interview exists."
        );


        await chrome.alarms.clear(
          TIMELINE_MONITOR_ALARM
        );


        return;

      }


      await collectAndWriteTimeline(
        activeInterview,
        "alarm"
      );

    } catch (error) {

      console.error(
        "Timeline monitor alarm error:",
        error
      );

    }

  }
);


// =====================================================
// COLLECT + WRITE TIMELINE
// =====================================================

async function collectAndWriteTimeline(
  activeInterview,
  source
) {

  /*
   * Prevent overlapping API calls.
   *
   * Chrome alarms can fire again while the previous
   * Google API request is still running.
   */

  if (timelineCollectionRunning) {

    console.log(
      "Timeline collection already running. Skipping:",
      source
    );

    return;

  }


  timelineCollectionRunning =
    true;


  try {

    console.log(
      `Timeline monitor check (${source}):`,
      activeInterview
    );


    /* -------------------------------------------------
       GET TIMELINE
    ------------------------------------------------- */

    const knownInterviewer = {
      email: activeInterview.interviewerEmail || null,
      userId: activeInterview.interviewerUserId || null,
      name: activeInterview.interviewerName || null
    };

    const timeline =
      await getInterviewTimeline(
        activeInterview.meetUrl,
        activeInterview.candidateEmail,
        false,
        knownInterviewer,
        activeInterview.candidateName || null
      );


    console.log(
      `Timeline result (${source}):`,
      timeline
    );


    /* -------------------------------------------------
       WRITE AVAILABLE VALUES
    ------------------------------------------------- */

    if (timeline) {

      try {

        const writeResult =
          await writeInterviewTimeline(
            activeInterview.rowNumber,
            timeline,
            false
          );


        console.log(
          `Timeline write result (${source}):`,
          writeResult
        );

      } catch (writeError) {

        /*
         * Do not stop the monitor because one Sheet
         * write failed.
         */

        console.error(
          "Could not write timeline to Sheet:",
          writeError
        );

      }

    }


    /* -------------------------------------------------
       COMPLETE
    ------------------------------------------------- */

    if (
      timeline &&
      timeline.complete
    ) {

      console.log(
        "Interview timeline is complete."
      );


      await chrome.alarms.clear(
        TIMELINE_MONITOR_ALARM
      );


      await chrome.storage.local.remove(
        ACTIVE_INTERVIEW_KEY
      );


      console.log(
        "Timeline monitor completed and cleaned up."
      );


      return;

    }


    /* -------------------------------------------------
       STILL INCOMPLETE
    ------------------------------------------------- */

    console.log(
      "Timeline incomplete. Monitor will continue."
    );


  } catch (error) {

    /*
     * IMPORTANT:
     *
     * A temporary Meet/People API error must NOT
     * kill the monitor.
     *
     * The next alarm will try again.
     */

    console.warn(
      `Timeline monitor check failed (${source}). ` +
      "Will retry on the next alarm.",
      error
    );

  } finally {

    timelineCollectionRunning =
      false;

  }

}


// =====================================================
// SERVICE WORKER ERROR PROTECTION
// =====================================================

self.addEventListener(
  "unhandledrejection",
  event => {

    console.error(
      "Unhandled background promise rejection:",
      event.reason
    );

  }
);



