/**
 * timestamp-writer.js
 *
 * Writes only the 4 interview timeline timestamps:
 *
 * - Interviewer Join Time
 * - Interviewer Leave Time
 * - Candidate Join Time
 * - Candidate Leave Time
 *
 * Columns are located by HEADER NAME.
 */


/**
 * Build a map of header name -> zero-based column index.
 * Maps both exact case and lowercase for resilient matching.
 */
function findColumnIndexes(headers) {
  const indexes = {};

  headers.forEach((header, index) => {
    const normalizedHeader = String(header || "").trim();

    if (normalizedHeader) {
      indexes[normalizedHeader] = index;
      indexes[normalizedHeader.toLowerCase()] = index;
    }
  });

  return indexes;
}


/**
 * Resiliently find a column index anywhere in row 1 by primary header name or aliases.
 */
function findColumnIndexForHeader(indexes, headers, primaryHeader, aliases = []) {
  if (!primaryHeader) {
    return undefined;
  }

  // 1. Direct match (exact case or lowercased)
  if (indexes[primaryHeader] !== undefined) {
    return indexes[primaryHeader];
  }

  const primaryLower = primaryHeader.toLowerCase().trim();
  if (indexes[primaryLower] !== undefined) {
    return indexes[primaryLower];
  }

  // 2. Check aliases
  for (const alias of aliases) {
    const aliasLower = String(alias || "").toLowerCase().trim();
    if (indexes[aliasLower] !== undefined) {
      return indexes[aliasLower];
    }
  }

  // 3. Normalized header search (ignoring punctuation and extra spaces)
  const cleanTarget = primaryLower.replace(/[^a-z0-9]/g, "");
  for (let i = 0; i < headers.length; i++) {
    const cleanHeader = String(headers[i] || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (cleanHeader === cleanTarget) {
      return i;
    }
    for (const alias of aliases) {
      if (cleanHeader === String(alias || "").toLowerCase().replace(/[^a-z0-9]/g, "")) {
        return i;
      }
    }
  }

  // 4. Substring inclusion search
  for (let i = 0; i < headers.length; i++) {
    const hLower = String(headers[i] || "").toLowerCase().trim();
    if (hLower.includes(primaryLower) || primaryLower.includes(hLower)) {
      return i;
    }
    for (const alias of aliases) {
      const aLower = String(alias || "").toLowerCase().trim();
      if (hLower.includes(aLower) || aLower.includes(hLower)) {
        return i;
      }
    }
  }

  return undefined;
}


/**
 * Read the entire header/data range.
 *
 * A:ZZ is intentional so timestamp columns can be anywhere.
 */
async function getSheetData(interactive = true) {
  const range = encodeURIComponent(
    `${CONFIG.SHEET_NAME}!A:ZZ`
  );

  const response = await googleApiRequest(
    `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SPREADSHEET_ID}/values/${range}`,
    {},
    interactive
  );

  return response.values || [];
}


/**
 * Convert zero-based column index to Google Sheets column letter.
 *
 * 0  -> A
 * 25 -> Z
 * 26 -> AA
 * 36 -> AK
 */
function columnNumberToLetter(index) {
  let number = index + 1;
  let result = "";

  while (number > 0) {
    const remainder = (number - 1) % 26;

    result =
      String.fromCharCode(65 + remainder) + result;

    number = Math.floor((number - 1) / 26);
  }

  return result;
}


/**
 * Convert Meet API UTC timestamp to IST Time (HH:MM:SS).
 *
 * Example:
 * 2026-09-09T18:11:49.683663Z
 *
 * becomes:
 * 23:41:49
 */
function formatTimestampIST(timestamp) {
  if (!timestamp) {
    return "";
  }

  try {
    const date = new Date(timestamp);

    if (Number.isNaN(date.getTime())) {
      console.warn(
        "Invalid timestamp received:",
        timestamp
      );

      return "";
    }

    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    }).formatToParts(date);

    const values = {};

    parts.forEach(part => {
      if (part.type !== "literal") {
        values[part.type] = part.value;
      }
    });

    return `${values.hour}:${values.minute}:${values.second}`;

  } catch (error) {
    console.error(
      "Could not format timestamp:",
      timestamp,
      error
    );

    return "";
  }
}


/**
 * Write one value to one Sheet cell.
 */
async function writeSheetCell(
  columnIndex,
  sheetRow,
  value,
  interactive = true
) {
  const columnLetter =
    columnNumberToLetter(columnIndex);

  const range = encodeURIComponent(
    `${CONFIG.SHEET_NAME}!${columnLetter}${sheetRow}`
  );

  console.log("Writing Sheet cell:", {
    column: columnLetter,
    row: sheetRow,
    value
  });

  // Force Google Sheets to treat the time string strictly as plain text.
  // This prevents Google Sheets from applying existing DATE_TIME column formatting
  // (which would prepend '30/12/1899' or today's date).
  const textValue =
    value && !String(value).startsWith("'")
      ? `'${value}`
      : (value || "");

  await googleApiRequest(
    `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SPREADSHEET_ID}/values/${range}?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",

      body: JSON.stringify({
        range:
          `${CONFIG.SHEET_NAME}!${columnLetter}${sheetRow}`,

        majorDimension: "ROWS",

        values: [
          [textValue]
        ]
      })
    },
    interactive
  );

  console.log(
    `Sheet cell written successfully: ${columnLetter}${sheetRow} -> ${value}`
  );
}


/**
 * Write the interview timeline.
 *
 * ONLY FOUR FIELDS ARE WRITTEN.
 */
async function writeInterviewTimeline(
  rowNumber,
  timeline,
  interactive = true
) {
  if (!rowNumber) {
    throw new Error("Missing row number");
  }

  if (!timeline) {
    throw new Error("Missing interview timeline");
  }

  console.log(
    "Preparing to write interview timeline:",
    timeline
  );

  const rows = await getSheetData(interactive);

  if (!rows.length) {
    throw new Error("Google Sheet is empty");
  }

  const headers = rows[0];

  const indexes =
    findColumnIndexes(headers);


  /**
   * Only these four columns matter, located anywhere in Row 1.
   */
  const timelineColumns = [
    {
      header: CONFIG.COLUMNS.INTERVIEWER_JOIN,
      aliases: [
        "Interviewer Join",
        "Interviewer Joined",
        "Interviewer Start Time",
        "Interviewer Join Time (IST)",
        "Interviewer Start"
      ],
      value: formatTimestampIST(
        timeline.interviewerJoinTime
      )
    },

    {
      header: CONFIG.COLUMNS.INTERVIEWER_LEAVE,
      aliases: [
        "Interviewer Leave",
        "Interviewer Left",
        "Interviewer End Time",
        "Interviewer Leave Time (IST)",
        "Interviewer End"
      ],
      value: formatTimestampIST(
        timeline.interviewerLeaveTime
      )
    },

    {
      header: CONFIG.COLUMNS.CANDIDATE_JOIN,
      aliases: [
        "Candidate Join",
        "Candidate Joined",
        "Candidate Start Time",
        "Candidate Join Time (IST)",
        "Candidate Start"
      ],
      value: formatTimestampIST(
        timeline.candidateJoinTime
      )
    },

    {
      header: CONFIG.COLUMNS.CANDIDATE_LEAVE,
      aliases: [
        "Candidate Leave",
        "Candidate Left",
        "Candidate End Time",
        "Candidate Leave Time (IST)",
        "Candidate End"
      ],
      value: formatTimestampIST(
        timeline.candidateLeaveTime
      )
    }
  ];


  const sheetRow = Number(rowNumber);

  /**
   * Write each field individually to its identified column.
   * Unjoined / unleft fields (item.value === "") are skipped,
   * leaving those cells completely blank in the Sheet.
   */
  for (const item of timelineColumns) {
    const columnIndex =
      findColumnIndexForHeader(
        indexes,
        headers,
        item.header,
        item.aliases
      );

    if (columnIndex === undefined) {
      console.warn(
        `Sheet column not found: "${item.header}". Skipping this column.`
      );
      continue;
    }

    // Only write if there is a timestamp value
    if (item.value) {
      await writeSheetCell(
        columnIndex,
        sheetRow,
        item.value,
        interactive
      );
    }
  }


  console.log(
    `Interview timeline written successfully to row ${sheetRow}`
  );

  return {
    success: true,
    rowNumber: sheetRow,
    written: timelineColumns.map(item => ({
      header: item.header,
      value: item.value
    }))
  };
}

// Backward compatibility alias for popup.js
const writeInterviewTimelineToSheet = writeInterviewTimeline;
