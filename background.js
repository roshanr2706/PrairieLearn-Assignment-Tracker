const STORAGE_META_KEY = "pl.meta";
const STORAGE_COURSE_PREFIX = "pl.course.";
const REFRESH_CONCURRENCY = 3;

chrome.runtime.onInstalled.addListener(() => {
  ensureMetaInitialized().catch((error) => {
    console.error("Failed to initialize storage metadata:", error);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void (async () => {
    try {
      if (!message || typeof message !== "object" || typeof message.type !== "string") {
        sendResponse({ ok: false, error: "Invalid message payload." });
        return;
      }

      if (message.type === "PL_HOME_COURSES_DISCOVERED") {
        const refreshSummary = await handleHomeCoursesDiscovered(message.payload, sender);
        const dashboard = await buildDashboardData();
        sendResponse({ ok: true, refreshSummary, data: dashboard });
        return;
      }

      if (message.type === "PL_REFRESH_REQUEST") {
        const refreshSummary = await handleRefreshRequest(message.payload, sender);
        const dashboard = await buildDashboardData();
        sendResponse({ ok: true, refreshSummary, data: dashboard });
        return;
      }

      if (message.type === "PL_GET_DASHBOARD") {
        const dashboard = await buildDashboardData();
        sendResponse({ ok: true, data: dashboard });
        return;
      }

      sendResponse({ ok: false, error: `Unsupported message type: ${message.type}` });
    } catch (error) {
      sendResponse({ ok: false, error: toErrorMessage(error) });
    }
  })();

  return true;
});

async function ensureMetaInitialized() {
  const currentMeta = await getMeta();
  if (currentMeta) {
    return;
  }

  await chrome.storage.local.set({
    [STORAGE_META_KEY]: {
      createdAt: new Date().toISOString(),
      origin: null,
      courseInstanceIds: [],
      lastDiscoveryAt: null,
      lastRefreshAt: null,
      lastError: null,
      lastRefreshSummary: null,
    },
  });
}

async function handleHomeCoursesDiscovered(payload, sender) {
  const senderOrigin = getSenderOrigin(sender);
  const origin = normalizePrairieLearnOrigin(payload?.origin) || senderOrigin;
  if (!origin) {
    throw new Error("Could not determine PrairieLearn origin from home page.");
  }

  const courseInstanceIds = sanitizeCourseInstanceIds(payload?.courseInstanceIds);
  if (!courseInstanceIds.length) {
    throw new Error("No PrairieLearn course IDs found on the home page.");
  }

  await updateMeta({
    origin,
    courseInstanceIds,
    lastDiscoveryAt: new Date().toISOString(),
    lastError: null,
  });

  return refreshCourses(origin, courseInstanceIds);
}

async function handleRefreshRequest(payload, sender) {
  const meta = await getMeta();
  const senderOrigin = getSenderOrigin(sender);

  const explicitOrigin = normalizePrairieLearnOrigin(payload?.origin);
  const storedOrigin = normalizePrairieLearnOrigin(meta?.origin);
  const origin = explicitOrigin || storedOrigin || senderOrigin;

  if (!origin) {
    throw new Error(
      "No PrairieLearn origin is known yet. Open PrairieLearn home page (/) once while logged in."
    );
  }

  let courseInstanceIds = sanitizeCourseInstanceIds(payload?.courseInstanceIds);
  if (!courseInstanceIds.length) {
    courseInstanceIds = sanitizeCourseInstanceIds(meta?.courseInstanceIds);
  }
  if (!courseInstanceIds.length) {
    try {
      courseInstanceIds = await fetchCourseInstanceIdsFromHome(origin);
    } catch {
      courseInstanceIds = [];
    }
  }
  if (!courseInstanceIds.length) {
    const pageAttempt = await runPageContextRefreshAttempt(origin, []);
    const discoveredIds = sanitizeCourseInstanceIds(
      (Array.isArray(pageAttempt.snapshots) ? pageAttempt.snapshots : []).map(
        (snapshot) => snapshot?.courseInstanceId
      )
    );
    return persistRefreshAttempt(origin, discoveredIds, pageAttempt);
  }

  await updateMeta({
    origin,
    courseInstanceIds,
    lastDiscoveryAt: new Date().toISOString(),
    lastError: null,
  });

  return refreshCourses(origin, courseInstanceIds);
}

async function refreshCourses(origin, courseInstanceIds) {
  const ids = sanitizeCourseInstanceIds(courseInstanceIds);
  if (!ids.length) {
    throw new Error("Cannot refresh courses without course IDs.");
  }

  let attempt = await runBackgroundRefreshAttempt(origin, ids);

  if (attempt.succeeded === 0 && attempt.failed === ids.length) {
    try {
      const pageAttempt = await runPageContextRefreshAttempt(origin, ids);
      if (pageAttempt.succeeded > 0 || pageAttempt.failed < attempt.failed) {
        attempt = pageAttempt;
      } else {
        attempt.errors.push({
          courseInstanceId: "*",
          error: "Page-context refresh did not improve results.",
        });
      }
    } catch (error) {
      attempt.errors.push({
        courseInstanceId: "*",
        error: `Page-context fallback failed: ${toErrorMessage(error)}`,
      });
    }
  }

  return persistRefreshAttempt(origin, ids, attempt);
}

async function runBackgroundRefreshAttempt(origin, courseInstanceIds) {
  const startedAt = new Date().toISOString();
  const results = await mapWithConcurrency(courseInstanceIds, REFRESH_CONCURRENCY, async (courseInstanceId) => {
    try {
      const snapshot = await fetchAndParseAssessments(origin, courseInstanceId);
      return { ok: true, courseInstanceId, snapshot };
    } catch (error) {
      return { ok: false, courseInstanceId, error: toErrorMessage(error) };
    }
  });

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
    mode: "background",
    origin,
    requestedCourseCount: courseInstanceIds.length,
    succeeded: snapshots.length,
    failed: errors.length,
    snapshots,
    errors,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

async function runPageContextRefreshAttempt(origin, courseInstanceIds) {
  const tabSession = await ensurePrairieLearnTab(origin);
  try {
    const response = await sendMessageToTab(tabSession.tabId, {
      type: "PL_PAGE_REFRESH_REQUEST",
      payload: {
        origin,
        courseInstanceIds,
      },
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Page-context refresh message failed.");
    }

    const snapshots = Array.isArray(response.snapshots) ? response.snapshots : [];
    const errors = Array.isArray(response.errors) ? response.errors : [];
    return {
      mode: response.mode || "page_context",
      origin: normalizePrairieLearnOrigin(response.origin) || origin,
      requestedCourseCount: Number.isFinite(response.requestedCourseCount)
        ? response.requestedCourseCount
        : courseInstanceIds.length,
      succeeded: Number.isFinite(response.succeeded) ? response.succeeded : snapshots.length,
      failed: Number.isFinite(response.failed) ? response.failed : errors.length,
      snapshots,
      errors,
      startedAt: response.startedAt || new Date().toISOString(),
      finishedAt: response.finishedAt || new Date().toISOString(),
    };
  } finally {
    if (tabSession.created) {
      try {
        await chrome.tabs.remove(tabSession.tabId);
      } catch {
        // Ignore tab cleanup errors.
      }
    }
  }
}

async function persistRefreshAttempt(origin, courseInstanceIds, attempt) {
  const updates = {};
  const snapshots = Array.isArray(attempt.snapshots) ? attempt.snapshots : [];
  for (const snapshot of snapshots) {
    const courseInstanceId = String(snapshot?.courseInstanceId || "").trim();
    if (!/^\d+$/.test(courseInstanceId)) {
      continue;
    }
    updates[getCourseStorageKey(courseInstanceId)] = snapshot;
  }

  const errors = Array.isArray(attempt.errors) ? attempt.errors : [];
  const requestedCourseCount = Number.isFinite(attempt.requestedCourseCount)
    ? attempt.requestedCourseCount
    : courseInstanceIds.length;
  const summary = {
    origin,
    mode: attempt.mode || "background",
    requestedCourseCount,
    succeeded: snapshots.length,
    failed: errors.length,
    errors,
    startedAt: attempt.startedAt || new Date().toISOString(),
    finishedAt: attempt.finishedAt || new Date().toISOString(),
  };

  const meta = await updateMeta({
    origin,
    courseInstanceIds,
    lastRefreshAt: summary.finishedAt,
    lastRefreshSummary: summary,
    lastError: errors.length ? summarizeRefreshErrors(errors) : null,
  });

  updates[STORAGE_META_KEY] = meta;
  await chrome.storage.local.set(updates);
  return summary;
}

async function fetchCourseInstanceIdsFromHome(origin) {
  const candidates = ["/", "/pl/"];
  for (const candidate of candidates) {
    const homeUrl = new URL(candidate, origin).toString();
    const response = await fetch(homeUrl, { credentials: "include" });
    if (!response.ok) {
      continue;
    }

    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const courseInstanceIds = extractCourseInstanceIdsFromHomeDocument(doc);
    if (courseInstanceIds.length) {
      return courseInstanceIds;
    }
  }

  throw new Error(
    "Could not parse enrolled courses from PrairieLearn home page. The page format may have changed."
  );
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
    throw new Error("Assessments table was not found. You may be logged out or the page changed.");
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

async function buildDashboardData() {
  const all = await chrome.storage.local.get(null);
  const meta = all[STORAGE_META_KEY] || null;

  const snapshots = Object.entries(all)
    .filter(([key]) => key.startsWith(STORAGE_COURSE_PREFIX))
    .map(([, value]) => value)
    .filter((value) => value && Array.isArray(value.assessments));

  const upcoming = [];
  let assessmentCount = 0;

  for (const snapshot of snapshots) {
    for (const assessment of snapshot.assessments) {
      assessmentCount += 1;
      if (!assessment || typeof assessment !== "object") {
        continue;
      }

      const isClosed =
        assessment.status === "closed" ||
        /assessment closed/i.test(assessment.availabilityText || "") ||
        /assessment closed/i.test(assessment.scoreText || "");

      if (isClosed) {
        continue;
      }

      upcoming.push({
        courseInstanceId: snapshot.courseInstanceId,
        courseLabel: assessment.courseLabel || snapshot.courseLabel || snapshot.courseInstanceId || "Course",
        group: assessment.group || null,
        badge: assessment.badge || null,
        title: assessment.title || "Untitled",
        href: assessment.absoluteUrl || toAbsoluteAssessmentUrl(snapshot.origin, assessment.href),
        dueAt: assessment.dueAt || null,
        availabilityText: assessment.availabilityText || null,
        score: assessment.score || null,
        status: assessment.status || "unknown",
        capturedAt: assessment.capturedAt || snapshot.updatedAt || null,
      });
    }
  }

  upcoming.sort(compareUpcomingAssessments);

  return {
    meta,
    stats: {
      courseSnapshots: snapshots.length,
      assessments: assessmentCount,
      upcoming: upcoming.length,
    },
    upcoming,
  };
}

function compareUpcomingAssessments(a, b) {
  const aTime = a.dueAt ? Date.parse(a.dueAt) : Number.NaN;
  const bTime = b.dueAt ? Date.parse(b.dueAt) : Number.NaN;

  const aHasDate = !Number.isNaN(aTime);
  const bHasDate = !Number.isNaN(bTime);

  if (aHasDate && bHasDate && aTime !== bTime) {
    return aTime - bTime;
  }
  if (aHasDate && !bHasDate) {
    return -1;
  }
  if (!aHasDate && bHasDate) {
    return 1;
  }

  const byCourse = a.courseLabel.localeCompare(b.courseLabel);
  if (byCourse !== 0) {
    return byCourse;
  }

  const byBadge = (a.badge || "").localeCompare(b.badge || "");
  if (byBadge !== 0) {
    return byBadge;
  }

  return a.title.localeCompare(b.title);
}

function toAbsoluteAssessmentUrl(origin, href) {
  if (typeof href !== "string" || !href) {
    return null;
  }

  const normalizedOrigin = normalizePrairieLearnOrigin(origin);
  if (!normalizedOrigin) {
    return href;
  }

  try {
    return new URL(href, normalizedOrigin).toString();
  } catch {
    return href;
  }
}

async function getMeta() {
  const result = await chrome.storage.local.get(STORAGE_META_KEY);
  return result[STORAGE_META_KEY] || null;
}

async function updateMeta(patch) {
  const existing = (await getMeta()) || {};
  const next = {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await chrome.storage.local.set({ [STORAGE_META_KEY]: next });
  return next;
}

function getCourseStorageKey(courseInstanceId) {
  return `${STORAGE_COURSE_PREFIX}${courseInstanceId}`;
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

function getSenderOrigin(sender) {
  if (!sender?.url) {
    return null;
  }

  try {
    const url = new URL(sender.url);
    return normalizePrairieLearnOrigin(url.origin);
  } catch {
    return null;
  }
}

async function ensurePrairieLearnTab(origin) {
  const domainTabs = await chrome.tabs.query({ url: ["https://*.prairielearn.com/*"] });
  let chosenTab = null;

  for (const tab of domainTabs) {
    if (!tab?.id || typeof tab.url !== "string") {
      continue;
    }
    try {
      if (new URL(tab.url).origin === origin) {
        chosenTab = tab;
        break;
      }
    } catch {
      // Ignore malformed tab URLs.
    }
  }

  if (chosenTab?.id) {
    await waitForTabComplete(chosenTab.id, 10000);
    return { tabId: chosenTab.id, created: false };
  }

  const created = await chrome.tabs.create({ url: `${origin}/`, active: false });
  if (!created?.id) {
    throw new Error("Failed to create PrairieLearn tab for refresh.");
  }

  await waitForTabComplete(created.id, 20000);
  return { tabId: created.id, created: true };
}

async function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      resolve(response);
    });
  });
}

async function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for PrairieLearn tab to load."));
    }, timeoutMs);

    const onUpdated = (updatedTabId, info) => {
      if (updatedTabId !== tabId) {
        return;
      }
      if (info.status === "complete") {
        settled = true;
        cleanup();
        resolve();
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };

    chrome.tabs.onUpdated.addListener(onUpdated);

    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (settled) {
          return;
        }
        if (tab?.status === "complete") {
          cleanup();
          resolve();
        }
      })
      .catch(() => {
        cleanup();
        reject(new Error("PrairieLearn tab closed before refresh could start."));
      });
  });
}

function summarizeRefreshErrors(errors) {
  if (!Array.isArray(errors) || !errors.length) {
    return null;
  }

  const preview = errors
    .slice(0, 2)
    .map((entry) => {
      const courseInstanceId = entry?.courseInstanceId || "?";
      const message = entry?.error || "Unknown failure";
      return `${courseInstanceId}: ${message}`;
    })
    .join(" | ");

  if (errors.length > 2) {
    return `${preview} (+${errors.length - 2} more)`;
  }
  return preview;
}

function normalizeWhitespace(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.replace(/\s+/g, " ").trim();
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
