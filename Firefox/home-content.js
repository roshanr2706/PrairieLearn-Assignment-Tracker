const REFRESH_CONCURRENCY = 3;
const HOME_CARD_ID = "pl-tracker-upcoming-card";
const HOME_CARD_BODY_ID = "pl-tracker-upcoming-body";
const HOME_CARD_SUBTITLE_ID = "pl-tracker-upcoming-subtitle";
const HOME_CARD_REFRESH_ID = "pl-tracker-upcoming-refresh";
const HOME_CARD_EMPTY_CLASS = "pl-tracker-upcoming-empty";

if (isPrairieLearnHomePage()) {
  void initHomeUpcomingSection();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    return;
  }

  if (message.type !== "PL_PAGE_REFRESH_REQUEST") {
    return;
  }

  void (async () => {
    try {
      const result = await runRefreshInPageContext(message.payload || {});
      sendResponse({ ok: true, ...result });
    } catch (error) {
      sendResponse({ ok: false, error: toErrorMessage(error) });
    }
  })();

  return true;
});

async function initHomeUpcomingSection() {
  const host = await waitForHomeCardsHost(10000);
  if (!host) {
    return;
  }

  ensureHomeUpcomingCard(host);
  await refreshAndRenderHomeUpcoming();
}

function isPrairieLearnHomePage() {
  const path = window.location.pathname || "/";
  return path === "/" || path === "/pl" || path === "/pl/";
}

function getHomeCardsHost() {
  return document.querySelector('div[data-component="HomeCards"].js-hydrated-component');
}

async function waitForHomeCardsHost(timeoutMs) {
  const existing = getHomeCardsHost();
  if (existing) {
    return existing;
  }

  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      const next = getHomeCardsHost();
      if (next) {
        observer.disconnect();
        resolve(next);
      }
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.setTimeout(() => {
      observer.disconnect();
      resolve(getHomeCardsHost());
    }, timeoutMs);
  });
}

function ensureHomeUpcomingCard(host) {
  const existing = document.getElementById(HOME_CARD_ID);
  if (existing && host.contains(existing)) {
    return existing;
  }

  const card = createHomeUpcomingCard();
  const firstCard = host.querySelector(":scope > .card");
  host.insertBefore(card, firstCard || host.firstChild);
  return card;
}

function createHomeUpcomingCard() {
  const card = document.createElement("div");
  card.id = HOME_CARD_ID;
  card.className = "card mb-4";

  const header = document.createElement("div");
  header.className = "card-header bg-primary text-white d-flex align-items-center";

  const title = document.createElement("h2");
  title.className = "mb-0";
  title.textContent = "Upcoming";

  const subtitle = document.createElement("p");
  subtitle.id = HOME_CARD_SUBTITLE_ID;
  subtitle.className = "mb-0 ms-3 small opacity-75";
  subtitle.textContent = "Loading...";

  const refreshButton = document.createElement("button");
  refreshButton.id = HOME_CARD_REFRESH_ID;
  refreshButton.type = "button";
  refreshButton.className = "btn btn-light btn-sm ms-auto";
  refreshButton.textContent = "Refresh";

  refreshButton.addEventListener("click", async () => {
    refreshButton.disabled = true;
    try {
      await refreshAndRenderHomeUpcoming();
    } catch (error) {
      setHomeCardSubtitle(`Refresh failed: ${toErrorMessage(error)}`);
    } finally {
      refreshButton.disabled = false;
    }
  });

  header.appendChild(title);
  header.appendChild(subtitle);
  header.appendChild(refreshButton);
  card.appendChild(header);

  const body = document.createElement("div");
  body.id = HOME_CARD_BODY_ID;
  body.className = "card-body";
  body.textContent = "Loading upcoming assessments...";
  card.appendChild(body);

  return card;
}

async function loadAndRenderHomeUpcomingFromBackground() {
  try {
    const response = await sendMessageToBackground({ type: "PL_GET_DASHBOARD" });
    if (!response?.ok) {
      throw new Error(response?.error || "Failed to load tracker dashboard.");
    }

    renderHomeUpcomingFromDashboard(response.data);
  } catch (error) {
    renderHomeUpcomingError(toErrorMessage(error));
  }
}

async function refreshAndRenderHomeUpcoming() {
  setHomeCardSubtitle("Refreshing...");
  const response = await sendMessageToBackground({
    type: "PL_REFRESH_REQUEST",
    payload: { origin: window.location.origin },
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Refresh failed.");
  }

  if (response.data) {
    renderHomeUpcomingFromDashboard(response.data);
    return;
  }

  await loadAndRenderHomeUpcomingFromBackground();
}

function renderHomeUpcomingFromDashboard(dashboard) {
  const host = getHomeCardsHost();
  if (!host) {
    return;
  }
  ensureHomeUpcomingCard(host);

  const body = document.getElementById(HOME_CARD_BODY_ID);
  if (!body) {
    return;
  }

  const filtered = getTwoWeekPendingAssessments(dashboard);
  const refreshedAt = dashboard?.meta?.lastRefreshAt || null;
  const refreshedLabel = refreshedAt ? `Last updated ${formatHomeDueAt(refreshedAt)}` : "Last updated just now";

  body.replaceChildren();
  if (!filtered.length) {
    const empty = document.createElement("p");
    empty.className = HOME_CARD_EMPTY_CLASS;
    empty.textContent = "No incomplete assessments due in the next 2 weeks.";
    body.appendChild(empty);
    setHomeCardSubtitle(refreshedLabel);
    return;
  }

  body.classList.remove(HOME_CARD_EMPTY_CLASS);

  const tableResponsive = document.createElement("div");
  tableResponsive.className = "table-responsive";

  const table = document.createElement("table");
  table.className = "table table-sm table-hover table-striped mb-0";
  table.setAttribute("aria-label", "Upcoming incomplete assessments");

  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  for (const label of ["Course", "Assessment", "Due", "Progress"]) {
    const heading = document.createElement("th");
    heading.textContent = label;
    headerRow.appendChild(heading);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const item of filtered) {
    const row = document.createElement("tr");

    const courseCell = document.createElement("td");
    courseCell.className = "align-middle";
    courseCell.textContent = item.courseLabel || "Course";
    row.appendChild(courseCell);

    const assessmentCell = document.createElement("td");
    assessmentCell.className = "align-middle";

    if (item.badge) {
      const badge = document.createElement("span");
      badge.className = "badge bg-secondary me-2";
      badge.textContent = item.badge;
      assessmentCell.appendChild(badge);
    }

    const link = document.createElement("a");
    link.href = item.href || "#";
    link.textContent = item.title || "Untitled";
    if (!item.href) {
      link.removeAttribute("href");
    }
    assessmentCell.appendChild(link);
    row.appendChild(assessmentCell);

    const dueCell = document.createElement("td");
    dueCell.className = "align-middle text-nowrap";
    dueCell.textContent = formatHomeDueAt(item.dueAt);
    row.appendChild(dueCell);

    const progressCell = document.createElement("td");
    progressCell.className = "align-middle";
    progressCell.textContent = getHomeProgressLabel(item);
    row.appendChild(progressCell);

    tbody.appendChild(row);
  }

  table.appendChild(tbody);
  tableResponsive.appendChild(table);
  body.appendChild(tableResponsive);
  setHomeCardSubtitle(` `);
}

function renderHomeUpcomingError(message) {
  const body = document.getElementById(HOME_CARD_BODY_ID);
  if (!body) {
    return;
  }

  body.replaceChildren();
  const error = document.createElement("p");
  error.className = "text-danger mb-0";
  error.textContent = `Unable to load upcoming tracker data: ${message}`;
  body.appendChild(error);
  setHomeCardSubtitle("Data unavailable");
}

function setHomeCardSubtitle(text) {
  const subtitle = document.getElementById(HOME_CARD_SUBTITLE_ID);
  if (subtitle) {
    subtitle.textContent = text;
  }
}

function getTwoWeekPendingAssessments(dashboard) {
  const upcoming = Array.isArray(dashboard?.upcoming) ? dashboard.upcoming : [];
  const now = Date.now();
  const twoWeeksMs = 14 * 24 * 60 * 60 * 1000;
  const maxDue = now + twoWeeksMs;

  return upcoming
    .filter((item) => {
      const dueTime = Date.parse(item?.dueAt || "");
      if (Number.isNaN(dueTime) || dueTime < now || dueTime > maxDue) {
        return false;
      }

      const scorePercent = parseScorePercent(item?.score);
      return scorePercent === null || scorePercent < 100;
    })
    .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
}

function formatHomeDueAt(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "No due date";
  }

  return date.toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getHomeProgressLabel(item) {
  if (item?.score) {
    return item.score;
  }
  if (item?.status === "not_started") {
    return "Not started";
  }
  if (item?.status === "action_available") {
    return "Action available";
  }
  if (item?.status === "text_status") {
    return "In progress";
  }
  return "Unknown";
}

function parseScorePercent(score) {
  if (typeof score !== "string") {
    return null;
  }

  const match = score.match(/(\d+(?:\.\d+)?)\s*%/);
  if (!match) {
    return null;
  }

  const value = Number.parseFloat(match[1]);
  return Number.isNaN(value) ? null : value;
}

async function runRefreshInPageContext(payload) {
  const origin = normalizePrairieLearnOrigin(payload?.origin) || normalizePrairieLearnOrigin(window.location.origin);
  if (!origin) {
    throw new Error("Invalid PrairieLearn origin in page-context refresh.");
  }

  let courseInstanceIds = sanitizeCourseInstanceIds(payload?.courseInstanceIds);
  if (!courseInstanceIds.length) {
    courseInstanceIds = extractCourseInstanceIdsFromHomeDocument(document);
  }
  if (!courseInstanceIds.length) {
    courseInstanceIds = await fetchCourseInstanceIdsFromHome(origin);
  }
  if (!courseInstanceIds.length) {
    throw new Error("No PrairieLearn course IDs found in page context.");
  }

  const startedAt = new Date().toISOString();
  const results = await mapWithConcurrency(
    courseInstanceIds,
    REFRESH_CONCURRENCY,
    async (courseInstanceId) => {
      try {
        const snapshot = await fetchAndParseAssessments(origin, courseInstanceId);
        return { ok: true, courseInstanceId, snapshot };
      } catch (error) {
        return { ok: false, courseInstanceId, error: toErrorMessage(error) };
      }
    }
  );

  const snapshots = [];
  const errors = [];
  for (const result of results) {
    if (result.ok) {
      snapshots.push(result.snapshot);
    } else {
      errors.push({ courseInstanceId: result.courseInstanceId, error: result.error });
    }
  }

  return {
    mode: "page_context",
    origin,
    requestedCourseCount: courseInstanceIds.length,
    succeeded: snapshots.length,
    failed: errors.length,
    errors,
    snapshots,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

async function fetchCourseInstanceIdsFromHome(origin) {
  const candidates = ["/", "/pl/"];
  for (const candidate of candidates) {
    const url = new URL(candidate, origin).toString();
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) {
      continue;
    }

    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const ids = extractCourseInstanceIdsFromHomeDocument(doc);
    if (ids.length) {
      return ids;
    }
  }

  return [];
}

async function fetchAndParseAssessments(origin, courseInstanceId) {
  const assessmentsUrl = new URL(
    `/pl/course_instance/${encodeURIComponent(courseInstanceId)}/assessments`,
    origin
  ).toString();

  const response = await fetch(assessmentsUrl, { credentials: "include" });
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}.`);
  }

  const html = await response.text();
  const doc = new DOMParser().parseFromString(html, "text/html");
  const parsed = parseAssessmentsDocument(doc, {
    origin,
    assessmentsUrl,
    courseInstanceId,
  });

  if (!parsed) {
    throw new Error("Assessments table was not found.");
  }

  return parsed;
}

function parseAssessmentsDocument(doc, context) {
  const tbody = doc.querySelector('table[aria-label="Assessments"] tbody');
  if (!tbody) {
    return null;
  }

  const capturedAt = new Date().toISOString();
  const courseLabel =
    normalizeWhitespace(doc.querySelector("#main-nav .navbar-text")?.textContent) || null;

  const assessments = [];
  let currentGroup = null;

  const rows = Array.from(tbody.querySelectorAll(":scope > tr"));
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
    const score = normalizeWhitespace(scoreCell.querySelector(".progress-bar")?.textContent);
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

  const decodedHtml = decodeHtmlEntities(raw);
  if (!decodedHtml) {
    return [];
  }

  const popoverDoc = new DOMParser().parseFromString(decodedHtml, "text/html");
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

function parsePrairieLearnTimestamp(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    return null;
  }

  const withoutTzLabel = raw.replace(/\s*\([^)]+\)\s*$/, "").trim();
  if (!withoutTzLabel) {
    return null;
  }

  let normalized = withoutTzLabel.replace(/\s+/, "T");
  normalized = normalized.replace(/([+-]\d{2})$/, "$1:00");

  const time = Date.parse(normalized);
  if (!Number.isNaN(time)) {
    return new Date(time).toISOString();
  }

  return null;
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

  if (
    Number.isNaN(hour) ||
    Number.isNaN(minute) ||
    Number.isNaN(day) ||
    month === undefined ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }

  const now = new Date();
  let candidate = new Date(now.getFullYear(), month, day, hour, minute, 0);

  if (candidate.getTime() < now.getTime() - 1000 * 60 * 60 * 24 * 120) {
    candidate = new Date(now.getFullYear() + 1, month, day, hour, minute, 0);
  }

  return candidate.toISOString();
}

function decodeHtmlEntities(value) {
  if (typeof value !== "string" || !value) {
    return "";
  }

  const doc = new DOMParser().parseFromString(`<!doctype html><body>${value}`, "text/html");
  return doc.body?.textContent || "";
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

function normalizePrairieLearnOrigin(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    return null;
  }

  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:") {
      return null;
    }
    if (host === "prairielearn.com" || host.endsWith(".prairielearn.com")) {
      return url.origin;
    }
  } catch {
    return null;
  }

  return null;
}

function normalizeWhitespace(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.replace(/\s+/g, " ").trim();
}

async function sendMessageToBackground(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      resolve(response);
    });
  });
}

function toErrorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string" && error) {
    return error;
  }
  return "Unknown error";
}

async function mapWithConcurrency(items, concurrency, worker) {
  const normalizedConcurrency = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array(items.length);
  let currentIndex = 0;

  const runners = Array.from({ length: normalizedConcurrency }, async () => {
    while (true) {
      const itemIndex = currentIndex;
      currentIndex += 1;
      if (itemIndex >= items.length) {
        return;
      }
      results[itemIndex] = await worker(items[itemIndex], itemIndex);
    }
  });

  await Promise.all(runners);
  return results;
}
