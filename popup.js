let currentCandidateRow = null;

let currentSheetName = null;

let currentCandidateResume = null;

let currentCandidateEmail = null;

let currentCandidateName = null;

let currentInterviewMeetUrl = null;


// =====================================================
// TEMPORARY TOAST MESSAGE
// =====================================================

function showMessage(text, type = "info", duration = 2500) {

  const message = document.getElementById("message");

  message.textContent = text;

  message.className = type;

  // Restart animation
  void message.offsetWidth;

  message.classList.add("show");

  clearTimeout(window.messageTimeout);

  window.messageTimeout = setTimeout(() => {

    message.classList.remove("show");

  }, duration);

}


// =====================================================
// GOOGLE AUTHENTICATION
// =====================================================

async function getGoogleToken() {

  try {

    console.log("Starting Google OAuth...");

    const result = await chrome.identity.getAuthToken({
      interactive: true
    });

    console.log("Google OAuth result:", result);

    const token =
      typeof result === "object" && result?.token
        ? result.token
        : result;

    if (!token || typeof token !== "string") {
      throw new Error(
        "Google OAuth returned no access token."
      );
    }

    console.log("Google OAuth successful.");

    return token;

  } catch (error) {

    console.error(
      "GOOGLE OAUTH ERROR:",
      error
    );

    throw new Error(
      `Google authentication failed: ${error.message}`
    );

  }

}


// =====================================================
// GET CURRENT INTERVIEWER PROFILE (AUTHENTICATED USER)
// =====================================================

async function getInterviewerProfile(token = null) {
  try {
    if (!token) {
      token = await getGoogleToken();
    }

    const response = await fetch(
      "https://www.googleapis.com/oauth2/v2/userinfo",
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json"
        }
      }
    );

    if (response.ok) {
      const data = await response.json();
      const profile = {
        email: (data.email || "").trim().toLowerCase(),
        userId: data.id || null,
        name: (data.name || "").trim()
      };

      await chrome.storage.local.set({ interviewerProfile: profile });
      console.log("Interviewer profile cached in popup:", profile);
      return profile;
    }
  } catch (err) {
    console.warn("Could not fetch interviewer profile in popup:", err);
  }

  try {
    const stored = await chrome.storage.local.get("interviewerProfile");
    if (stored?.interviewerProfile?.email || stored?.interviewerProfile?.userId) {
      return stored.interviewerProfile;
    }
  } catch (err) { }

  return { email: null, userId: null, name: null };
}


// =====================================================
// GET ACTIVE MEET URL
// =====================================================

async function getMeetUrl() {

  const tabs = await chrome.tabs.query({

    active: true,

    currentWindow: true

  });

  if (!tabs.length || !tabs[0].url) {

    throw new Error(
      "Could not find active tab."
    );

  }

  return tabs[0].url;

}


// =====================================================
// NORMALIZE MEET URL
// =====================================================

function normalizeMeetUrl(url) {

  if (!url) {

    return "";

  }

  try {

    const parsed = new URL(url);

    return (
      parsed.hostname +
      parsed.pathname
    )
      .replace(/\/$/, "")
      .toLowerCase();

  } catch (error) {

    return String(url)
      .replace(/\/$/, "")
      .toLowerCase();

  }

}


// =====================================================
// GET SPREADSHEET
// =====================================================

async function getSpreadsheet(token) {

  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/` +
    `${CONFIG.SPREADSHEET_ID}` +
    `?includeGridData=true`;

  const response = await fetch(url, {

    method: "GET",

    headers: {

      Authorization:
        `Bearer ${token}`

    }

  });

  if (!response.ok) {

    const text =
      await response.text();

    throw new Error(
      `Google Sheets error: ${text}`
    );

  }

  return await response.json();

}


// =====================================================
// FIND TARGET SHEET
// =====================================================

function findTargetSheet(spreadsheet) {

  const sheets =
    spreadsheet.sheets || [];

  if (!sheets.length) {

    throw new Error(
      "No sheets found in spreadsheet."
    );

  }

  const sheet =
    sheets.find(
      sheet =>
        sheet.properties.title ===
        CONFIG.SHEET_NAME
    );

  if (!sheet) {

    throw new Error(
      `Sheet "${CONFIG.SHEET_NAME}" was not found.`
    );

  }

  currentSheetName =
    sheet.properties.title;

  return sheet;

}


// =====================================================
// GET CELL VALUE
// =====================================================

function getCellValue(row, columnIndex) {

  if (
    !row ||
    !row.values ||
    !row.values[columnIndex]
  ) {

    return "";

  }

  return (
    row.values[columnIndex].formattedValue ||
    ""
  );

}


// =====================================================
// BUILD HEADER MAP
// =====================================================

function buildHeaderMap(headerRow) {

  const headerMap = {};

  if (
    !headerRow ||
    !headerRow.values
  ) {

    return headerMap;

  }

  headerRow.values.forEach(
    (cell, index) => {

      const header = (
        cell.formattedValue ||
        ""
      ).trim();

      if (header) {

        headerMap[header] =
          index;

      }

    }
  );

  return headerMap;

}


// =====================================================
// FIND COLUMN BY HEADER NAME
// =====================================================

function getColumnIndex(
  headerMap,
  headerName
) {

  if (!(headerName in headerMap)) {

    throw new Error(
      `Column "${headerName}" was not found in the sheet.`
    );

  }

  return headerMap[headerName];

}


// =====================================================
// DISPLAY CANDIDATE
// =====================================================

function displayCandidate(
  row,
  headerMap
) {

  // -------------------------------------------------
  // Candidate Name
  // -------------------------------------------------

  const name =
    getCellValue(
      row,
      getColumnIndex(
        headerMap,
        CONFIG.COLUMNS.NAME
      )
    );

  currentCandidateName = (name || "").trim();
  console.log("Candidate name:", currentCandidateName);


  // -------------------------------------------------
  // Candidate Email
  // -------------------------------------------------

  currentCandidateEmail = null;

  if (
    CONFIG.COLUMNS.EMAIL &&
    CONFIG.COLUMNS.EMAIL in headerMap
  ) {

    const email =
      getCellValue(
        row,
        headerMap[CONFIG.COLUMNS.EMAIL]
      )
        .trim()
        .toLowerCase();

    if (email) {

      currentCandidateEmail =
        email;

    }

  }

  console.log(
    "Candidate email:",
    currentCandidateEmail
  );


  // -------------------------------------------------
  // Phone
  // -------------------------------------------------

  const phone =
    getCellValue(
      row,
      getColumnIndex(
        headerMap,
        CONFIG.COLUMNS.PHONE
      )
    );


  // -------------------------------------------------
  // Specialization
  // -------------------------------------------------

  const specialization =
    getCellValue(
      row,
      getColumnIndex(
        headerMap,
        CONFIG.COLUMNS.SPECIALIZATION
      )
    );


  // -------------------------------------------------
  // Study Status
  // -------------------------------------------------

  const studyStatus =
    getCellValue(
      row,
      getColumnIndex(
        headerMap,
        CONFIG.COLUMNS.STUDY_STATUS
      )
    );


  // -------------------------------------------------
  // Role
  // -------------------------------------------------

  const role =
    getCellValue(
      row,
      getColumnIndex(
        headerMap,
        CONFIG.COLUMNS.ROLE
      )
    );


  // -------------------------------------------------
  // Interview Meet URL
  // -------------------------------------------------

  currentInterviewMeetUrl = null;

  if (
    CONFIG.COLUMNS.MEET_LINK &&
    CONFIG.COLUMNS.MEET_LINK in headerMap
  ) {

    const meetUrl =
      getCellValue(
        row,
        headerMap[CONFIG.COLUMNS.MEET_LINK]
      ).trim();

    if (meetUrl) {

      currentInterviewMeetUrl =
        meetUrl;

    }

  }

  console.log(
    "Interview Meet URL:",
    currentInterviewMeetUrl
  );


  // -------------------------------------------------
  // Candidate-specific Resume
  // -------------------------------------------------

  currentCandidateResume = null;

  if (
    CONFIG.COLUMNS.RESUME &&
    CONFIG.COLUMNS.RESUME in headerMap
  ) {

    const resume =
      getCellValue(
        row,
        headerMap[CONFIG.COLUMNS.RESUME]
      ).trim();

    if (resume) {

      currentCandidateResume =
        resume;

    }

  }

  console.log(
    "Candidate resume:",
    currentCandidateResume
  );


  // -------------------------------------------------
  // Display Candidate Information
  // -------------------------------------------------

  document.getElementById(
    "candidateName"
  ).textContent =
    name || "-";


  document.getElementById(
    "candidatePhone"
  ).textContent =
    phone || "-";


  document.getElementById(
    "candidateSpecialization"
  ).textContent =
    specialization || "-";


  document.getElementById(
    "candidateStudyStatus"
  ).textContent =
    studyStatus || "-";


  document.getElementById(
    "candidateRole"
  ).textContent =
    role || "-";


  // -------------------------------------------------
  // Resume Button State
  // -------------------------------------------------

  const resumeButton =
    document.getElementById(
      "resumeButton"
    );

  if (resumeButton) {

    if (currentCandidateResume) {

      resumeButton.disabled =
        false;

      resumeButton.style.opacity =
        "1";

      resumeButton.style.cursor =
        "pointer";

    } else {

      resumeButton.disabled =
        true;

      resumeButton.style.opacity =
        "0.55";

      resumeButton.style.cursor =
        "not-allowed";

    }

  }


  // -------------------------------------------------
  // Hide Loading / Empty State
  // -------------------------------------------------

  document.getElementById(
    "emptyState"
  ).style.display =
    "none";


  document.getElementById(
    "candidateSkeleton"
  ).classList.add(
    "hidden"
  );


  document.getElementById(
    "candidateContent"
  ).classList.remove(
    "hidden"
  );


  // -------------------------------------------------
  // Show Interview Outcome
  // -------------------------------------------------

  document.getElementById(
    "statusSection"
  ).classList.remove(
    "hidden"
  );


  // -------------------------------------------------
  // Show Remark
  // -------------------------------------------------

  document.getElementById(
    "remarkSection"
  ).classList.remove(
    "hidden"
  );


  // -------------------------------------------------
  // Load Existing Remark
  // -------------------------------------------------

  if (
    CONFIG.COLUMNS.REMARK &&
    CONFIG.COLUMNS.REMARK in headerMap
  ) {

    const remark =
      getCellValue(
        row,
        headerMap[CONFIG.COLUMNS.REMARK]
      );

    document.getElementById(
      "remark"
    ).value =
      remark || "";

  }

}


// =====================================================
// LOAD CANDIDATE
// =====================================================

async function loadCandidate() {

  // Show skeleton while loading

  document.getElementById(
    "candidateSkeleton"
  ).classList.remove(
    "hidden"
  );


  // Hide actual candidate information

  document.getElementById(
    "candidateContent"
  ).classList.add(
    "hidden"
  );


  // Reset resume button

  const resumeButton =
    document.getElementById(
      "resumeButton"
    );

  if (resumeButton) {

    resumeButton.disabled =
      true;

    resumeButton.style.opacity =
      "0.55";

    resumeButton.style.cursor =
      "not-allowed";

  }


  // Reset previous candidate

  currentCandidateRow =
    null;

  currentSheetName =
    null;

  currentCandidateResume =
    null;

  currentCandidateEmail =
    null;

  currentInterviewMeetUrl =
    null;


  showMessage(
    "Loading candidate...",
    "info"
  );


  try {

    // -------------------------------------------------
    // 1. AUTHENTICATION
    // -------------------------------------------------

    const token =
      await getGoogleToken();


    // -------------------------------------------------
    // 2. GET CURRENT TAB URL
    // -------------------------------------------------

    const meetUrl =
      await getMeetUrl();

    console.log(
      "Current Meet URL:",
      meetUrl
    );


    if (
      !meetUrl.includes(
        "meet.google.com"
      )
    ) {

      throw new Error(
        "Please open the Google Meet interview first."
      );

    }


    // -------------------------------------------------
    // 3. GET SPREADSHEET
    // -------------------------------------------------

    const spreadsheet =
      await getSpreadsheet(token);


    // -------------------------------------------------
    // 4. FIND TARGET SHEET
    // -------------------------------------------------

    const sheet =
      findTargetSheet(
        spreadsheet
      );

    console.log(
      "Using sheet:",
      currentSheetName
    );


    // -------------------------------------------------
    // 5. GET ROW DATA
    // -------------------------------------------------

    const gridData =
      sheet.data &&
        sheet.data[0] &&
        sheet.data[0].rowData
        ? sheet.data[0].rowData
        : [];


    if (!gridData.length) {

      throw new Error(
        "No data found in sheet."
      );

    }


    // -------------------------------------------------
    // 6. BUILD HEADER MAP
    // -------------------------------------------------

    const headerRow =
      gridData[0];

    const headerMap =
      buildHeaderMap(
        headerRow
      );

    console.log(
      "Header map:",
      headerMap
    );


    // -------------------------------------------------
    // 7. FIND MEET LINK COLUMN
    // -------------------------------------------------

    const meetLinkColumn =
      getColumnIndex(
        headerMap,
        CONFIG.COLUMNS.MEET_LINK
      );


    // -------------------------------------------------
    // 8. SEARCH FOR CANDIDATE
    // -------------------------------------------------

    let foundCandidate =
      null;


    for (
      let i = 1;
      i < gridData.length;
      i++
    ) {

      const row =
        gridData[i];


      const sheetMeetUrl =
        getCellValue(
          row,
          meetLinkColumn
        );


      console.log(
        "Checking Meet:",
        sheetMeetUrl
      );


      if (
        normalizeMeetUrl(
          sheetMeetUrl
        ) ===
        normalizeMeetUrl(
          meetUrl
        )
      ) {

        foundCandidate =
          row;


        // Google Sheets rows are 1-based

        currentCandidateRow =
          i + 1;


        break;

      }

    }


    // -------------------------------------------------
    // 9. CANDIDATE NOT FOUND
    // -------------------------------------------------

    if (!foundCandidate) {

      throw new Error(
        "No candidate found for this Google Meet link."
      );

    }


    console.log(
      "Candidate found at row:",
      currentCandidateRow
    );


    // -------------------------------------------------
    // 10. DISPLAY CANDIDATE
    // -------------------------------------------------

    displayCandidate(
      foundCandidate,
      headerMap
    );


    showMessage(
      "Candidate loaded successfully ✅",
      "success"
    );


    // -------------------------------------------------
    // 10b. TARGETED SINGLE-CANDIDATE CONTACT VERIFICATION
    //
    // Check if THIS specific candidate's email is in the
    // interviewer's Google Contacts. If not, add them now.
    // This allows People API to resolve their exact email
    // during the Meet, ignoring any 3rd-party attendees.
    // -------------------------------------------------

    if (currentCandidateEmail) {
      try {
        console.log("[contacts] Verifying candidate in contacts:", currentCandidateEmail);
        const seedResult = await ensureCandidateContact(
          currentCandidateEmail,
          currentCandidateName || "",
          token
        );
        console.log(
          "[contacts] Candidate contact check result:",
          seedResult.status,
          seedResult.resourceName || seedResult.error || ""
        );
      } catch (seedErr) {
        console.warn("[contacts] Candidate contact check error (non-fatal):", seedErr.message);
      }
    }


    // -------------------------------------------------
    // 11. AUTOMATICALLY START TIMELINE MONITOR
    // -------------------------------------------------

    if (
      currentInterviewMeetUrl &&
      currentCandidateEmail &&
      currentCandidateRow
    ) {

      console.log(
        "Auto-starting interview timeline monitor..."
      );

      const interviewerProfile =
        await getInterviewerProfile(token);

      const monitorPayload = {
        meetUrl: currentInterviewMeetUrl,
        candidateEmail: currentCandidateEmail,
        candidateName: currentCandidateName,
        rowNumber: currentCandidateRow,
        interviewerEmail: interviewerProfile?.email || null,
        interviewerUserId: interviewerProfile?.userId || null,
        interviewerName: interviewerProfile?.name || null,
        token: token,
        startedAt: Date.now()
      };

      // 1. Immediately persist active interview and last auth token in storage
      try {
        await chrome.storage.local.set({
          activeInterviewTimeline: monitorPayload,
          lastAuthToken: token
        });

        // Ensure the background alarm is active
        chrome.alarms.create("interview-timeline-monitor", {
          delayInMinutes: 0.5,
          periodInMinutes: 0.5
        });
      } catch (storageErr) {
        console.warn("Storage/alarm setup notice:", storageErr);
      }

      // 2. Perform immediate timeline collection right here in the popup
      // where the user token is confirmed active and fresh
      try {
        const initialTimeline = await getInterviewTimeline(
          currentInterviewMeetUrl,
          currentCandidateEmail,
          true,
          interviewerProfile,
          currentCandidateName
        );

        if (initialTimeline) {
          await writeInterviewTimeline(
            currentCandidateRow,
            initialTimeline,
            true
          );
          console.log(
            "Initial timeline captured and written to Sheet from popup:",
            initialTimeline
          );
        }
      } catch (timelineErr) {
        console.log(
          "Initial timeline check notice:",
          timelineErr?.message || timelineErr
        );
      }

      // 3. Dispatch message to background service worker
      try {
        chrome.runtime.sendMessage(
          {
            type: "START_INTERVIEW_MONITOR",
            payload: monitorPayload
          },
          response => {
            if (chrome.runtime.lastError) {
              console.warn(
                "Notice on START_INTERVIEW_MONITOR message:",
                chrome.runtime.lastError.message,
                "(Monitor is already active in storage and alarms. If extension was recently reloaded, please close and reopen the side panel)."
              );
            } else {
              console.log(
                "Timeline monitor active in background:",
                response
              );
            }
          }
        );
      } catch (msgErr) {
        console.warn("Could not dispatch message to background worker:", msgErr);
      }

    }

  } catch (error) {

    console.error(
      "Load candidate error:",
      error
    );


    showMessage(
      error.message,
      "error"
    );

  }

}


// =====================================================
// COLUMN NUMBER → LETTER
// =====================================================

function columnToLetter(
  columnIndex
) {

  let letter = "";

  let temp =
    columnIndex + 1;


  while (temp > 0) {

    const remainder =
      (temp - 1) % 26;


    letter =
      String.fromCharCode(
        65 + remainder
      ) + letter;


    temp =
      Math.floor(
        (temp - 1) / 26
      );

  }


  return letter;

}


// =====================================================
// UPDATE INTERVIEW OUTCOME
// =====================================================

async function updateStatus(
  newStatus
) {

  if (!currentCandidateRow) {

    showMessage(
      "Please wait for the candidate to load.",
      "error"
    );

    return;

  }


  showMessage(
    `Updating outcome to "${newStatus}"...`,
    "info"
  );


  try {

    // -------------------------------------------------
    // 1. AUTHENTICATION
    // -------------------------------------------------

    const token =
      await getGoogleToken();


    // -------------------------------------------------
    // 2. GET SPREADSHEET
    // -------------------------------------------------

    const spreadsheet =
      await getSpreadsheet(
        token
      );


    // -------------------------------------------------
    // 3. FIND TARGET SHEET
    // -------------------------------------------------

    const sheet =
      findTargetSheet(
        spreadsheet
      );


    // -------------------------------------------------
    // 4. GET HEADER DATA
    // -------------------------------------------------

    const gridData =
      sheet.data &&
        sheet.data[0] &&
        sheet.data[0].rowData
        ? sheet.data[0].rowData
        : [];


    const headerMap =
      buildHeaderMap(
        gridData[0]
      );


    // -------------------------------------------------
    // 5. FIND STATUS COLUMN
    // -------------------------------------------------

    const statusColumn =
      getColumnIndex(
        headerMap,
        CONFIG.COLUMNS.STATUS
      );


    const statusColumnLetter =
      columnToLetter(
        statusColumn
      );


    // -------------------------------------------------
    // 6. BUILD CELL RANGE
    // -------------------------------------------------

    const range =
      `'${currentSheetName}'!` +
      `${statusColumnLetter}` +
      `${currentCandidateRow}`;


    console.log(
      "Updating range:",
      range
    );


    // -------------------------------------------------
    // 7. UPDATE SHEET
    // -------------------------------------------------

    const url =
      `https://sheets.googleapis.com/v4/spreadsheets/` +
      `${CONFIG.SPREADSHEET_ID}` +
      `/values/` +
      `${encodeURIComponent(range)}` +
      `?valueInputOption=USER_ENTERED`;


    const response =
      await fetch(
        url,
        {

          method: "PUT",

          headers: {

            Authorization:
              `Bearer ${token}`,

            "Content-Type":
              "application/json"

          },

          body: JSON.stringify({

            range: range,

            majorDimension:
              "ROWS",

            values: [
              [newStatus]
            ]

          })

        }
      );


    if (!response.ok) {

      const text =
        await response.text();


      throw new Error(
        `Failed to update outcome: ${text}`
      );

    }


    // -------------------------------------------------
    // 8. SHOW SUCCESS
    // -------------------------------------------------

    showMessage(
      `Outcome updated to "${newStatus}" ✅`,
      "success"
    );

  } catch (error) {

    console.error(
      "Outcome update error:",
      error
    );


    showMessage(
      error.message,
      "error"
    );

  }

}


// =====================================================
// SAVE INTERVIEW TIMELINE
// =====================================================

async function saveInterviewTimeline() {

  if (!currentCandidateRow) {

    throw new Error(
      "Candidate Sheet row is not available."
    );

  }


  if (!currentCandidateEmail) {

    throw new Error(
      "Candidate Email is missing from the Sheet."
    );

  }


  if (!currentInterviewMeetUrl) {

    throw new Error(
      "Interview Meet link is missing."
    );

  }


  console.log(
    "Starting interview timeline collection..."
  );


  console.log(
    "Candidate email:",
    currentCandidateEmail
  );


  console.log(
    "Meet URL:",
    currentInterviewMeetUrl
  );


  let interviewerProfile = null;
  try {
    interviewerProfile = await getCurrentUserProfile(true);
  } catch (_) { }

  const timeline =
    await getInterviewTimeline(
      currentInterviewMeetUrl,
      currentCandidateEmail,
      true,
      interviewerProfile,
      currentCandidateName
    );


  console.log(
    "Interview timeline:",
    timeline
  );


  // -------------------------------------------------
  // Write timeline to Sheet
  // -------------------------------------------------

  if (timeline) {
    await writeInterviewTimelineToSheet(
      currentCandidateRow,
      timeline
    );

    console.log(
      "Interview timeline written to Sheet."
    );
  }


  // -------------------------------------------------
  // If conference is still active / incomplete
  // schedule background retry
  // -------------------------------------------------

  if (!timeline || !timeline.complete) {

    console.log(
      "Timeline incomplete. Scheduling background retry."
    );


    getInterviewerProfile().then(profile => {
      chrome.runtime.sendMessage(
        {
          type:
            "SCHEDULE_TIMESTAMP_RETRY",
          payload: {
            meetUrl:
              currentInterviewMeetUrl,
            candidateEmail:
              currentCandidateEmail,
            rowNumber:
              currentCandidateRow,
            interviewerEmail:
              profile?.email || null,
            interviewerUserId:
              profile?.userId || null,
            interviewerName:
              profile?.name || null,
            attempts:
              0
          }
        },
        () => {
          if (chrome.runtime.lastError) {
            // Ignored if background listener is disconnected
          }
        }
      );
    }).catch(() => { });

  }


  return timeline;

}


// =====================================================
// SAVE REMARK
// =====================================================

async function saveRemark() {

  if (!currentCandidateRow) {

    showMessage(
      "Please wait for the candidate to load.",
      "error"
    );

    return;

  }


  const remark =
    document.getElementById(
      "remark"
    ).value;


  showMessage(
    "Saving remark...",
    "info"
  );


  try {

    // -------------------------------------------------
    // 1. AUTHENTICATION
    // -------------------------------------------------

    const token =
      await getGoogleToken();


    // -------------------------------------------------
    // 2. GET SPREADSHEET
    // -------------------------------------------------

    const spreadsheet =
      await getSpreadsheet(
        token
      );


    // -------------------------------------------------
    // 3. FIND TARGET SHEET
    // -------------------------------------------------

    const sheet =
      findTargetSheet(
        spreadsheet
      );


    // -------------------------------------------------
    // 4. GET HEADER DATA
    // -------------------------------------------------

    const gridData =
      sheet.data &&
        sheet.data[0] &&
        sheet.data[0].rowData
        ? sheet.data[0].rowData
        : [];


    const headerMap =
      buildHeaderMap(
        gridData[0]
      );


    // -------------------------------------------------
    // 5. FIND REMARK COLUMN
    // -------------------------------------------------

    const remarkColumn =
      getColumnIndex(
        headerMap,
        CONFIG.COLUMNS.REMARK
      );


    const remarkColumnLetter =
      columnToLetter(
        remarkColumn
      );


    // -------------------------------------------------
    // 6. BUILD CELL RANGE
    // -------------------------------------------------

    const range =
      `'${currentSheetName}'!` +
      `${remarkColumnLetter}` +
      `${currentCandidateRow}`;


    console.log(
      "Updating remark range:",
      range
    );


    // -------------------------------------------------
    // 7. UPDATE SHEET
    // -------------------------------------------------

    const url =
      `https://sheets.googleapis.com/v4/spreadsheets/` +
      `${CONFIG.SPREADSHEET_ID}` +
      `/values/` +
      `${encodeURIComponent(range)}` +
      `?valueInputOption=USER_ENTERED`;


    const response =
      await fetch(
        url,
        {

          method: "PUT",

          headers: {

            Authorization:
              `Bearer ${token}`,

            "Content-Type":
              "application/json"

          },

          body: JSON.stringify({

            range: range,

            majorDimension:
              "ROWS",

            values: [
              [remark]
            ]

          })

        }
      );


    if (!response.ok) {

      const text =
        await response.text();


      throw new Error(
        `Failed to save remark: ${text}`
      );

    }


    // -------------------------------------------------
    // 8. REMARK SAVED
    // -------------------------------------------------

    console.log(
      "Remark saved successfully."
    );


    // -------------------------------------------------
    // 9. COLLECT INTERVIEW TIMELINE
    // -------------------------------------------------

    try {

      const timeline =
        await saveInterviewTimeline();


      if (timeline && timeline.complete) {

        showMessage(
          "Remark and interview timing saved successfully ✅",
          "success"
        );

      } else {

        showMessage(
          "Remark saved. Interview timing will finish automatically ⏳",
          "success",
          4000
        );

      }

    } catch (timelineError) {

      console.error(
        "Interview timeline save error:",
        timelineError
      );


      // -------------------------------------------------
      // Schedule retry only when candidate/Meet data
      // may not be ready yet.
      // -------------------------------------------------

      if (
        currentCandidateEmail &&
        currentInterviewMeetUrl &&
        currentCandidateRow
      ) {

        console.log(
          "Scheduling background timeline retry..."
        );


        try {

          chrome.runtime.sendMessage(
            {
              type:
                "SCHEDULE_TIMESTAMP_RETRY",

              payload: {
                meetUrl:
                  currentInterviewMeetUrl,

                candidateEmail:
                  currentCandidateEmail,

                rowNumber:
                  currentCandidateRow,

                interviewerEmail:
                  (await chrome.storage.local.get("interviewerProfile"))?.interviewerProfile?.email || null,

                interviewerUserId:
                  (await chrome.storage.local.get("interviewerProfile"))?.interviewerProfile?.userId || null,

                interviewerName:
                  (await chrome.storage.local.get("interviewerProfile"))?.interviewerProfile?.name || null,

                attempts:
                  0
              }
            },
            () => {
              if (chrome.runtime.lastError) {
                // Ignored if background listener is disconnected
              }
            }
          );

        } catch (scheduleError) {

          console.error(
            "Could not schedule timeline retry:",
            scheduleError
          );

        }

      }


      showMessage(
        `Remark saved. Interview timing will be retried automatically.`,
        "success",
        4000
      );

    }

  } catch (error) {

    console.error(
      "Remark save error:",
      error
    );


    showMessage(
      error.message,
      "error"
    );

  }

}


// =====================================================
// OPEN CANDIDATE RESUME
// =====================================================

function openCandidateResume() {

  if (!currentCandidateRow) {

    showMessage(
      "Please wait for the candidate to load.",
      "error"
    );

    return;

  }


  if (!currentCandidateResume) {

    showMessage(
      "Resume is not available for this candidate.",
      "error"
    );

    return;

  }


  try {

    chrome.tabs.create({

      url:
        currentCandidateResume

    });

  } catch (error) {

    console.error(
      "Resume open error:",
      error
    );


    showMessage(
      "Could not open the resume.",
      "error"
    );

  }

}


// =====================================================
// OPEN INTERVIEW QUESTIONS
// =====================================================

function openInterviewQuestions() {

  if (
    !CONFIG.QUESTIONS_URL
  ) {

    showMessage(
      "Interview questions link is not configured.",
      "error"
    );

    return;

  }


  try {

    chrome.tabs.create({

      url:
        CONFIG.QUESTIONS_URL

    });

  } catch (error) {

    console.error(
      "Interview questions open error:",
      error
    );


    showMessage(
      "Could not open interview questions.",
      "error"
    );

  }

}


// =====================================================
// INITIALIZE CUSTOM STATUS DROPDOWN
// =====================================================

function initializeStatusDropdown() {

  const dropdown =
    document.getElementById(
      "statusDropdown"
    );


  const selected =
    document.getElementById(
      "statusSelected"
    );


  const optionsContainer =
    document.getElementById(
      "statusOptions"
    );


  if (
    !dropdown ||
    !selected ||
    !optionsContainer
  ) {

    console.error(
      "Status dropdown elements not found."
    );

    return;

  }


  // -------------------------------------------------
  // Open / Close Dropdown
  // -------------------------------------------------

  selected.addEventListener(
    "click",
    () => {

      optionsContainer.classList.toggle(
        "hidden"
      );

    }
  );


  // -------------------------------------------------
  // Create Status Options
  // -------------------------------------------------

  CONFIG.STATUS_OPTIONS.forEach(
    status => {

      const option =
        document.createElement(
          "div"
        );


      option.className =
        "statusOption";


      const chip =
        document.createElement(
          "span"
        );


      chip.className =
        "statusChip " +
        getStatusClass(status);


      chip.textContent =
        status;


      option.appendChild(
        chip
      );


      option.addEventListener(
        "click",
        async () => {

          // Update selected display

          selected.innerHTML = `

            <span class="statusChip ${getStatusClass(status)}">
              ${status}
            </span>

            <span class="dropdownArrow">
              ▼
            </span>

          `;


          // Close dropdown

          optionsContainer.classList.add(
            "hidden"
          );


          // Update Google Sheet

          await updateStatus(
            status
          );

        }
      );


      optionsContainer.appendChild(
        option
      );

    }
  );


  // -------------------------------------------------
  // Close When Clicking Outside
  // -------------------------------------------------

  document.addEventListener(
    "click",
    event => {

      if (
        !dropdown.contains(
          event.target
        )
      ) {

        optionsContainer.classList.add(
          "hidden"
        );

      }

    }
  );

}


// =====================================================
// STATUS → CSS CLASS
// =====================================================

function getStatusClass(
  status
) {

  switch (status) {

    case "Selected":

      return "status-selected";


    case "Rejected":

      return "status-rejected";


    case "No Show 1":

      return "status-no-show-1";


    case "No Show 2":

      return "status-no-show-2";


    case "Hold":

      return "status-hold";


    default:

      return "";

  }

}


// =====================================================
// INITIALIZE EXTENSION
// =====================================================

document.addEventListener(
  "DOMContentLoaded",
  async () => {

    // -------------------------------------------------
    // Eagerly identify extension starter (interviewer)
    // -------------------------------------------------

    try {
      const token = await getGoogleToken();
      await getInterviewerProfile(token);
    } catch (authErr) {
      console.warn("Could not pre-fetch interviewer profile:", authErr);
    }


    // -------------------------------------------------
    // Populate status dropdown
    // -------------------------------------------------

    initializeStatusDropdown();


    // -------------------------------------------------
    // Resume button
    // -------------------------------------------------

    const resumeButton =
      document.getElementById(
        "resumeButton"
      );


    if (resumeButton) {

      resumeButton.addEventListener(
        "click",
        openCandidateResume
      );

    }


    // -------------------------------------------------
    // Interview Questions button
    // -------------------------------------------------

    const questionsButton =
      document.getElementById(
        "questionsButton"
      );


    if (questionsButton) {

      questionsButton.addEventListener(
        "click",
        openInterviewQuestions
      );

    }


    // -------------------------------------------------
    // Save Remark button
    // -------------------------------------------------

    const saveRemarkButton =
      document.getElementById(
        "saveRemark"
      );


    if (saveRemarkButton) {

      saveRemarkButton.addEventListener(
        "click",
        saveRemark
      );

    }


    // -------------------------------------------------
    // Automatically load candidate
    // -------------------------------------------------

    await loadCandidate();

  }
);