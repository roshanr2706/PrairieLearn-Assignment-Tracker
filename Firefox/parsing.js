// Shared PrairieLearn HTML parsing helpers.
//
// These functions need DOM APIs (DOMParser, querySelector). A Chrome MV3
// service worker has none, so on Chrome this file is loaded by the offscreen
// document (offscreen.html) and the service worker talks to it over messages.
// On Firefox the background page has a DOM, so it loads this file directly via
// the manifest and calls these functions in-process.
//
// The parser body is the timezone-aware implementation that previously lived in
// background.js; it is unchanged here apart from being wrapped in a module.
(function initPrairieLearnTrackerParsing(global) {
  function normalizeWhitespace(value) {
    if (typeof value !== "string") {
      return "";
    }
    return value.replace(/\s+/g, " ").trim();
  }

  function sanitizeCourseInstanceIds(rawIds) {
    if (!Array.isArray(rawIds)) {
      return [];
    }

    const unique = new Set();
    for (const id of rawIds) {
      const normalized = String(id ?? "").trim();
      if (/^\d+$/.test(normalized)) {
        unique.add(normalized);
      }
    }

    return Array.from(unique);
  }

  // PrairieLearn renders a separate <tbody> for every assessment group, so
  // querySelector("tbody") only ever returns the first group. Walk them all and
  // keep document order so group headings still apply to the rows beneath them.
  function collectAssessmentTableRows(table) {
    if (!table) {
      return [];
    }

    const bodies = Array.from(table.querySelectorAll(":scope > tbody"));
    return bodies.flatMap((body) => Array.from(body.querySelectorAll(":scope > tr")));
  }

  function parseAssessmentsDocument(doc, context) {
    const table = doc.querySelector('table[aria-label="Assessments"]');
    if (!table) {
      return null;
    }

    const capturedAt = new Date().toISOString();
    const courseLabel =
      normalizeWhitespace(doc.querySelector("#main-nav .navbar-text")?.textContent) || null;

    const assessments = [];
    let currentGroup = null;

    const rows = collectAssessmentTableRows(table);
    for (const row of rows) {
      const groupHeading = row.querySelector('[data-testid="assessment-group-heading"]');
      if (groupHeading) {
        currentGroup = normalizeWhitespace(groupHeading.textContent);
        continue;
      }

      const badgeElement = row.querySelector('[data-testid="assessment-set-badge"]');
      const cells = row.querySelectorAll("td");
      if (!badgeElement || cells.length < 4) {
        continue;
      }

      const badge = normalizeWhitespace(badgeElement.textContent);

      const titleCell = cells[1];
      const linkElement = titleCell.querySelector("a");
      const title = normalizeWhitespace(linkElement?.textContent || titleCell.textContent) || "Untitled";
      const href = linkElement?.getAttribute("href") || null;
      const absoluteUrl = href ? new URL(href, context.origin).toString() : null;

      const availabilityCell = cells[2];
      const availabilityText = normalizeWhitespace(availabilityCell.textContent) || null;
      const popoverButton = availabilityCell.querySelector('button[data-bs-toggle="popover"]');
      const accessWindows = parsePopoverAccessDetails(popoverButton);

      const scoreCell = cells[3];
      const score = extractScorePercentFromCell(scoreCell);
      const scoreText = normalizeWhitespace(scoreCell.textContent);

      let status = "unknown";
      if (score) {
        status = "scored";
      } else if (/assessment closed/i.test(availabilityText || "") || /assessment closed/i.test(scoreText)) {
        status = "closed";
      } else if (/not started/i.test(scoreText)) {
        status = "not_started";
      } else if (scoreCell.querySelector("a.btn, button.btn")) {
        status = "action_available";
      } else if (scoreText) {
        status = "text_status";
      }

      const dueAt = getEffectiveDueTimestamp(accessWindows, availabilityText);

      assessments.push({
        courseInstanceId: context.courseInstanceId,
        courseLabel,
        group: currentGroup,
        badge,
        title,
        href,
        absoluteUrl,
        availabilityText,
        accessWindows,
        dueAt,
        score: score || null,
        scoreText: scoreText || null,
        status,
        capturedAt,
      });
    }

    return {
      courseInstanceId: context.courseInstanceId,
      courseLabel,
      origin: context.origin,
      sourceUrl: context.assessmentsUrl,
      assessments,
      updatedAt: capturedAt,
    };
  }

  function parsePopoverAccessDetails(buttonElement) {
    if (!buttonElement) {
      return [];
    }

    const raw = buttonElement.getAttribute("data-bs-content");
    if (!raw) {
      return [];
    }

    // getAttribute() already returns the decoded attribute value, so `raw` is
    // parseable HTML. Running it through a text-extracting decoder would strip
    // the <table> markup and leave no rows, losing every exact timestamp.
    const popoverDoc = new DOMParser().parseFromString(raw, "text/html");
    const rows = Array.from(popoverDoc.querySelectorAll("tr")).slice(1);
    if (!rows.length) {
      return [];
    }

    return rows.map((row) => {
      const values = Array.from(row.querySelectorAll("td")).map((cell) =>
        normalizeWhitespace(cell.textContent)
      );

      const credit = values[0] || null;
      const start = values[1] || null;
      const end = values[2] || null;

      return {
        credit,
        start,
        end,
        startIso: parsePrairieLearnTimestamp(start),
        endIso: parsePrairieLearnTimestamp(end),
      };
    });
  }

  function extractScorePercentFromCell(scoreCell) {
    if (!scoreCell) {
      return null;
    }

    const directPercent = findPercentString(scoreCell.querySelector(".progress-bar")?.textContent);
    if (directPercent) {
      return directPercent;
    }

    const ariaCandidates = [
      scoreCell.querySelector(".progress-bar")?.getAttribute("aria-valuenow"),
      scoreCell.querySelector(".progress")?.getAttribute("aria-valuenow"),
    ];
    for (const ariaValue of ariaCandidates) {
      const normalized = normalizeNumericPercentString(ariaValue);
      if (normalized) {
        return normalized;
      }
    }

    const styleCandidates = [
      scoreCell.querySelector(".progress-bar")?.getAttribute("style"),
      scoreCell.querySelector(".progress")?.getAttribute("style"),
    ];
    for (const styleValue of styleCandidates) {
      const widthPercent = findPercentFromStyle(styleValue);
      if (widthPercent) {
        return widthPercent;
      }
    }

    return findPercentString(scoreCell.textContent);
  }

  function findPercentFromStyle(styleText) {
    if (typeof styleText !== "string" || !styleText.trim()) {
      return null;
    }

    const match = styleText.match(/width\s*:\s*([+-]?\d+(?:\.\d+)?)\s*%/i);
    if (!match) {
      return null;
    }

    return normalizeNumericPercentString(match[1]);
  }

  function findPercentString(text) {
    if (typeof text !== "string" || !text.trim()) {
      return null;
    }

    const match = text.match(/([+-]?\d+(?:\.\d+)?)\s*%/);
    if (!match) {
      return null;
    }

    return normalizeNumericPercentString(match[1]);
  }

  function normalizeNumericPercentString(raw) {
    if (typeof raw !== "string" || !raw.trim()) {
      return null;
    }

    const value = Number.parseFloat(raw.trim());
    if (!Number.isFinite(value)) {
      return null;
    }

    const clamped = Math.min(Math.max(value, 0), 100);
    const rounded = Math.round(clamped * 10) / 10;
    const formatted = Number.isInteger(rounded) ? String(rounded) : String(rounded);
    return `${formatted}%`;
  }

  function getEffectiveDueTimestamp(accessWindows, availabilityText) {
    const windows = Array.isArray(accessWindows) ? accessWindows : [];
    const validEnds = windows
      .map((window) => window?.endIso)
      .filter((iso) => typeof iso === "string");

    if (validEnds.length) {
      validEnds.sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
      return validEnds[validEnds.length - 1];
    }

    return parseAvailabilityFallback(availabilityText);
  }

  // PrairieLearn stamps access windows with a timezone abbreviation, for example
  // "2026-09-24 23:59:59 (PDT)". Date.parse() ignores that label and reads the
  // value in whatever timezone the viewer happens to be in, which silently shifts
  // every deadline for anyone outside the course timezone. Offsets are in minutes
  // from UTC. Abbreviations that exist in more than one region resolve to their
  // North American reading, which is what PrairieLearn serves.
  const TIMEZONE_ABBREVIATION_OFFSETS = {
    UTC: 0,
    GMT: 0,
    Z: 0,
    NST: -210,
    NDT: -150,
    AST: -240,
    ADT: -180,
    EST: -300,
    EDT: -240,
    CST: -360,
    CDT: -300,
    MST: -420,
    MDT: -360,
    PST: -480,
    PDT: -420,
    AKST: -540,
    AKDT: -480,
    HST: -600,
    HDT: -540,
  };

  function parsePrairieLearnTimestamp(raw) {
    if (typeof raw !== "string" || !raw.trim()) {
      return null;
    }

    const tzLabel = raw.match(/\(([^)]+)\)\s*$/)?.[1] || null;
    const withoutTzLabel = raw.replace(/\s*\([^)]+\)\s*$/, "").trim();
    if (!withoutTzLabel) {
      return null;
    }

    let normalized = withoutTzLabel.replace(/\s+/, "T");
    normalized = normalized.replace(/([+-]\d{2})$/, "$1:00");

    // An offset already baked into the stamp wins over the trailing label.
    const offsetMinutes = /(?:Z|[+-]\d{2}:\d{2})$/.test(normalized)
      ? null
      : resolveTimezoneOffsetMinutes(tzLabel);
    if (offsetMinutes !== null) {
      normalized += formatUtcOffset(offsetMinutes);
    }

    const time = Date.parse(normalized);
    if (!Number.isNaN(time)) {
      return new Date(time).toISOString();
    }

    return null;
  }

  // Returns minutes from UTC, or null when the label is missing or unrecognised.
  // Null means "fall back to local time", which keeps an unknown zone working the
  // way it always has instead of dropping the deadline entirely.
  function resolveTimezoneOffsetMinutes(label) {
    if (typeof label !== "string" || !label.trim()) {
      return null;
    }

    const trimmed = label.trim();
    const named = TIMEZONE_ABBREVIATION_OFFSETS[trimmed.toUpperCase()];
    if (typeof named === "number") {
      return named;
    }

    // Also accept explicit forms such as "UTC-7", "GMT+5:30" or "+0530".
    const numeric = trimmed.match(/^(?:UTC|GMT)?\s*([+-])(\d{1,2}):?(\d{2})?$/i);
    if (!numeric) {
      return null;
    }

    const hours = Number.parseInt(numeric[2], 10);
    const minutes = numeric[3] ? Number.parseInt(numeric[3], 10) : 0;
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
      return null;
    }

    return (numeric[1] === "-" ? -1 : 1) * (hours * 60 + minutes);
  }

  function formatUtcOffset(offsetMinutes) {
    const sign = offsetMinutes < 0 ? "-" : "+";
    const absolute = Math.abs(offsetMinutes);
    const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
    const minutes = String(absolute % 60).padStart(2, "0");
    return `${sign}${hours}:${minutes}`;
  }

  function parseAvailabilityFallback(text) {
    if (typeof text !== "string") {
      return null;
    }

    const match = text.match(/until\s+(\d{1,2}):(\d{2}),\s*\w{3},\s*([A-Za-z]{3})\s+(\d{1,2})/i);
    if (!match) {
      return null;
    }

    const hour = Number.parseInt(match[1], 10);
    const minute = Number.parseInt(match[2], 10);
    const monthToken = match[3].toLowerCase();
    const day = Number.parseInt(match[4], 10);

    if (
      Number.isNaN(hour) ||
      Number.isNaN(minute) ||
      Number.isNaN(day) ||
      hour < 0 ||
      hour > 23 ||
      minute < 0 ||
      minute > 59 ||
      day < 1 ||
      day > 31
    ) {
      return null;
    }

    const monthLookup = {
      jan: 0,
      feb: 1,
      mar: 2,
      apr: 3,
      may: 4,
      jun: 5,
      jul: 6,
      aug: 7,
      sep: 8,
      oct: 9,
      nov: 10,
      dec: 11,
    };
    const month = monthLookup[monthToken];
    if (month === undefined) {
      return null;
    }

    const now = new Date();
    let candidate = new Date(now.getFullYear(), month, day, hour, minute, 0);

    if (candidate.getTime() < now.getTime() - 1000 * 60 * 60 * 24 * 120) {
      candidate = new Date(now.getFullYear() + 1, month, day, hour, minute, 0);
    }

    return candidate.toISOString();
  }

  function extractCourseInstanceIdsFromHomeDocument(doc) {
    const script = doc.querySelector(
      'script[type="application/json"][data-component="HomeCards"][data-component-props="true"]'
    );
    if (!script?.textContent) {
      return [];
    }

    let parsed;
    try {
      parsed = JSON.parse(script.textContent);
    } catch {
      return [];
    }

    const courses = Array.isArray(parsed?.json?.studentCourses) ? parsed.json.studentCourses : [];
    return sanitizeCourseInstanceIds(courses.map((course) => course?.course_instance?.id));
  }

  // String-in / JSON-out wrappers so a caller without its own DOM (the offscreen
  // document, or a Firefox background page) hands over raw HTML and gets plain
  // data back.
  function parseAssessmentsHtml(html, context) {
    const doc = new DOMParser().parseFromString(String(html ?? ""), "text/html");
    return parseAssessmentsDocument(doc, context || {});
  }

  function extractCourseInstanceIdsFromHomeHtml(html) {
    const doc = new DOMParser().parseFromString(String(html ?? ""), "text/html");
    return extractCourseInstanceIdsFromHomeDocument(doc);
  }

  global.PrairieLearnTrackerParsing = {
    parseAssessmentsHtml,
    extractCourseInstanceIdsFromHomeHtml,
    parseAssessmentsDocument,
    extractCourseInstanceIdsFromHomeDocument,
    parsePrairieLearnTimestamp,
    getEffectiveDueTimestamp,
    sanitizeCourseInstanceIds,
    normalizeWhitespace,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
