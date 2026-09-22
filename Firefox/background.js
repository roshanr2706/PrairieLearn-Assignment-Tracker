const STORAGE_META_KEY = "pl.meta";
const STORAGE_COURSE_PREFIX = "pl.course.";
const STORAGE_PINNED_KEY = "pl.pinned_assessments";
const STORAGE_V2_WELCOMED_KEY = "pl.v2.welcomed";
const REFRESH_CONCURRENCY = 3;

// A Chrome MV3 service worker has no DOMParser, so it loads the shared parser
// here and hands HTML to an offscreen document to parse. Firefox loads a real
// background page, so parsing.js comes in through the manifest and DOMParser is
// available in-process (see parseHtml below).
if (typeof importScripts === "function") {
  importScripts("parsing.js");
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  ensureMetaInitialized().catch((error) => {
    console.error("Failed to initialize storage metadata:", error);
  });

  if (reason === "install") {
    await chrome.storage.local.set({ [STORAGE_V2_WELCOMED_KEY]: true });
    chrome.tabs.create({ url: chrome.runtime.getURL("welcome/welcome.html") });
  } else if (reason === "update") {
    const result = await chrome.storage.local.get(STORAGE_V2_WELCOMED_KEY);
    if (!result[STORAGE_V2_WELCOMED_KEY]) {
      await chrome.storage.local.set({ [STORAGE_V2_WELCOMED_KEY]: true });
      chrome.tabs.create({ url: chrome.runtime.getURL("welcome/welcome.html") });
    }
  }
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

      if (message.type === "PL_GET_ASSESSMENT_PINS") {
        const data = await getAssessmentPinStates(message.payload);
        sendResponse({ ok: true, data });
        return;
      }

      if (message.type === "PL_TOGGLE_ASSESSMENT_PIN") {
        const result = await toggleAssessmentPin(message.payload);
        sendResponse({ ok: true, ...result });
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

  const DEFAULT_ORIGIN = "https://us.prairielearn.com";
  const explicitOrigin = normalizePrairieLearnOrigin(payload?.origin);
  const storedOrigin = normalizePrairieLearnOrigin(meta?.origin);
  const origin = explicitOrigin || storedOrigin || senderOrigin || DEFAULT_ORIGIN;

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
    const bgErrors = attempt.errors.map((e) => `${e.courseInstanceId}: ${e.error}`).join("; ");
    console.warn(
      `[PL Tracker] All ${ids.length} background fetches failed. Errors: ${bgErrors}. Trying page-context fallback...`
    );
    try {
      const pageAttempt = await runPageContextRefreshAttempt(origin, ids);
      if (pageAttempt.succeeded > 0 || pageAttempt.failed < attempt.failed) {
        attempt = pageAttempt;
      } else {
        attempt.errors.push({
          courseInstanceId: "*",
          error: `Page-context refresh also failed. Background errors: ${bgErrors}`,
        });
      }
    } catch (error) {
      attempt.errors.push({
        courseInstanceId: "*",
        error: `Page-context fallback failed: ${toErrorMessage(error)}. Background errors: ${bgErrors}`,
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
    const message = {
      type: "PL_PAGE_REFRESH_REQUEST",
      payload: {
        origin,
        courseInstanceIds,
      },
    };

    let response;
    let lastError;
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 1500;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        response = await sendMessageToTab(tabSession.tabId, message);
        lastError = null;
        break;
      } catch (tabError) {
        lastError = tabError;
        const isConnectionError = /does not exist|could not establish/i.test(
          toErrorMessage(tabError)
        );
        if (!isConnectionError || attempt === MAX_RETRIES - 1) {
          break;
        }

        // Content script not ready yet — try injecting it manually, then wait and retry.
        if (attempt === 0) {
          try {
            const scriptingApi =
              typeof browser !== "undefined" && browser?.scripting
                ? browser.scripting
                : chrome.scripting;
            await scriptingApi.executeScript({
              target: { tabId: tabSession.tabId },
              files: ["home-content.js"],
            });
          } catch {
            // Injection may fail if already loaded or permissions issue — ignore and retry anyway.
          }
        }

        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }

    if (lastError) {
      throw new Error(
        `Could not reach the PrairieLearn content script after ${MAX_RETRIES} attempts. ` +
        `Try reloading the PrairieLearn page. (${toErrorMessage(lastError)})`
      );
    }

    if (!response?.ok) {
      throw new Error(
        response?.error ||
        "Page-context refresh returned a failure. You may be logged out of PrairieLearn."
      );
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
    const courseInstanceIds = await parseHtml("EXTRACT_COURSE_INSTANCE_IDS", html);
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
  const parsed = await parseHtml("PARSE_ASSESSMENTS", html, {
    origin,
    assessmentsUrl,
    courseInstanceId,
  });

  if (!parsed) {
    throw new Error("Assessments table was not found. You may be logged out or the page changed.");
  }

  return parsed;
}

// --- HTML parsing bridge -----------------------------------------------------
//
// Parsing PrairieLearn pages needs DOMParser. A Chrome MV3 service worker has
// no DOM, so on Chrome we hand the HTML to an offscreen document and get plain
// JSON back. Firefox's background page has a DOM and parses in-process using the
// shared parsing.js loaded through the manifest.

const OFFSCREEN_TARGET = "pl-tracker-offscreen";
const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const OFFSCREEN_REQUEST_TIMEOUT_MS = 15000;

let offscreenDocumentPromise = null;

function getParsing() {
  const parsing = globalThis.PrairieLearnTrackerParsing;
  if (!parsing) {
    throw new Error("parsing.js was not loaded. Check the manifest and reload the extension.");
  }
  return parsing;
}

function canParseInPlace() {
  return typeof DOMParser !== "undefined" && Boolean(globalThis.PrairieLearnTrackerParsing);
}

async function parseHtml(op, html, context) {
  if (canParseInPlace()) {
    const parsing = getParsing();
    return op === "PARSE_ASSESSMENTS"
      ? parsing.parseAssessmentsHtml(html, context)
      : parsing.extractCourseInstanceIdsFromHomeHtml(html);
  }

  await ensureOffscreenDocument();
  const response = await sendOffscreenRequest({ target: OFFSCREEN_TARGET, op, html, context });
  if (!response?.ok) {
    throw new Error(response?.error || "Offscreen parsing failed.");
  }
  return response.data;
}

async function ensureOffscreenDocument() {
  if (!chrome.offscreen) {
    throw new Error(
      "This browser has no DOMParser in the background and no offscreen document API, " +
      "so PrairieLearn pages cannot be parsed in the background."
    );
  }

  // Chrome may close an idle offscreen document, so re-check every time rather
  // than remembering that we once created one.
  if (await chrome.offscreen.hasDocument()) {
    return;
  }

  // Only one offscreen document may exist, and a refresh fans out several
  // parses at once, so concurrent callers share a single creation promise.
  if (!offscreenDocumentPromise) {
    offscreenDocumentPromise = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_DOCUMENT_PATH,
        reasons: ["DOM_PARSER"],
        justification: "Parse fetched PrairieLearn HTML pages, which the service worker cannot do.",
      })
      .catch((error) => {
        // Lost a race with another creation: the document we need now exists.
        if (!/single offscreen document/i.test(toErrorMessage(error))) {
          throw error;
        }
      })
      .finally(() => {
        offscreenDocumentPromise = null;
      });
  }

  return offscreenDocumentPromise;
}

function sendOffscreenRequest(message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Timed out waiting for the offscreen parser to respond."));
    }, OFFSCREEN_REQUEST_TIMEOUT_MS);

    chrome.runtime.sendMessage(message, (response) => {
      clearTimeout(timer);
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      resolve(response);
    });
  });
}

async function getAssessmentPinStates(payload) {
  const assessments = Array.isArray(payload?.assessments) ? payload.assessments : [];
  let pinnedById = await getPinnedAssessmentStore();
  let changed = false;
  const nowMs = Date.now();

  for (const [pinId, pin] of Object.entries(pinnedById)) {
    if (isDueDateInPast(pin?.dueAt, nowMs)) {
      delete pinnedById[pinId];
      changed = true;
    }
  }

  const items = assessments.map((assessment) => {
    const identity = buildAssessmentIdentity(
      assessment,
      payload?.courseInstanceId || assessment?.courseInstanceId,
      payload?.origin || null
    );
    if (!identity) {
      return { pinId: null, pinned: false };
    }

    const existing = pinnedById[identity.pinId];
    if (!existing) {
      return { pinId: identity.pinId, pinned: false };
    }

    const latestDueAt = normalizeIsoTimestamp(assessment?.dueAt) || existing.dueAt || null;
    if (isDueDateInPast(latestDueAt, nowMs)) {
      delete pinnedById[identity.pinId];
      changed = true;
      return { pinId: identity.pinId, pinned: false };
    }

    const merged = mergePinEntryWithAssessment(existing, assessment, identity);
    if (merged.changed) {
      pinnedById[identity.pinId] = merged.entry;
      changed = true;
    }

    return { pinId: identity.pinId, pinned: true };
  });

  if (changed) {
    await chrome.storage.local.set({ [STORAGE_PINNED_KEY]: pinnedById });
  }

  return { items };
}

async function toggleAssessmentPin(payload) {
  const assessment = payload?.assessment;
  const identity = buildAssessmentIdentity(
    assessment,
    assessment?.courseInstanceId,
    payload?.origin || null
  );
  if (!identity) {
    throw new Error("Invalid assessment payload for pinning.");
  }

  let pinnedById = await getPinnedAssessmentStore();
  let changed = false;
  const nowMs = Date.now();

  for (const [pinId, pin] of Object.entries(pinnedById)) {
    if (isDueDateInPast(pin?.dueAt, nowMs)) {
      delete pinnedById[pinId];
      changed = true;
    }
  }

  const existing = pinnedById[identity.pinId];
  if (existing) {
    delete pinnedById[identity.pinId];
    changed = true;
    await chrome.storage.local.set({ [STORAGE_PINNED_KEY]: pinnedById });
    return { pinId: identity.pinId, pinned: false };
  }

  const dueAt = normalizeIsoTimestamp(assessment?.dueAt);
  if (isDueDateInPast(dueAt, nowMs)) {
    if (changed) {
      await chrome.storage.local.set({ [STORAGE_PINNED_KEY]: pinnedById });
    }
    return { pinId: identity.pinId, pinned: false };
  }

  pinnedById[identity.pinId] = createPinEntryFromAssessment(assessment, identity);
  await chrome.storage.local.set({ [STORAGE_PINNED_KEY]: pinnedById });
  return { pinId: identity.pinId, pinned: true };
}

async function getPinnedAssessmentStore() {
  const result = await chrome.storage.local.get(STORAGE_PINNED_KEY);
  return sanitizePinnedAssessmentStore(result[STORAGE_PINNED_KEY]);
}

function sanitizePinnedAssessmentStore(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }

  const sanitized = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }

    const pinId = typeof key === "string" && key.trim() ? key.trim() : null;
    const courseInstanceId = String(value.courseInstanceId || "").trim();
    if (!pinId || !/^\d+$/.test(courseInstanceId)) {
      continue;
    }

    const normalizedDueAt = normalizeIsoTimestamp(value.dueAt);
    sanitized[pinId] = {
      pinId,
      courseInstanceId,
      title: normalizeWhitespace(String(value.title || "Untitled")) || "Untitled",
      badge: normalizeWhitespace(String(value.badge || "")) || null,
      group: normalizeWhitespace(String(value.group || "")) || null,
      href: typeof value.href === "string" && value.href.trim() ? value.href : null,
      absoluteUrl: typeof value.absoluteUrl === "string" && value.absoluteUrl.trim()
        ? value.absoluteUrl
        : null,
      dueAt: normalizedDueAt,
      pinnedAt: normalizeIsoTimestamp(value.pinnedAt) || new Date().toISOString(),
      updatedAt: normalizeIsoTimestamp(value.updatedAt) || new Date().toISOString(),
    };
  }

  return sanitized;
}

function createPinEntryFromAssessment(assessment, identity) {
  return {
    pinId: identity.pinId,
    courseInstanceId: identity.courseInstanceId,
    title: normalizeWhitespace(assessment?.title || "") || "Untitled",
    badge: normalizeWhitespace(assessment?.badge || "") || null,
    group: normalizeWhitespace(assessment?.group || "") || null,
    href: identity.href || (typeof assessment?.href === "string" ? assessment.href : null),
    absoluteUrl:
      identity.absoluteUrl || (typeof assessment?.absoluteUrl === "string" ? assessment.absoluteUrl : null),
    dueAt: normalizeIsoTimestamp(assessment?.dueAt),
    pinnedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function mergePinEntryWithAssessment(existing, assessment, identity) {
  const merged = {
    ...existing,
    courseInstanceId: identity.courseInstanceId,
    title: normalizeWhitespace(assessment?.title || "") || existing.title || "Untitled",
    badge: normalizeWhitespace(assessment?.badge || "") || existing.badge || null,
    group: normalizeWhitespace(assessment?.group || "") || existing.group || null,
    href: identity.href || existing.href || null,
    absoluteUrl: identity.absoluteUrl || existing.absoluteUrl || null,
    dueAt: normalizeIsoTimestamp(assessment?.dueAt) || existing.dueAt || null,
    updatedAt: new Date().toISOString(),
  };

  const changed =
    merged.courseInstanceId !== existing.courseInstanceId ||
    merged.title !== existing.title ||
    merged.badge !== existing.badge ||
    merged.group !== existing.group ||
    merged.href !== existing.href ||
    merged.absoluteUrl !== existing.absoluteUrl ||
    merged.dueAt !== existing.dueAt;

  return {
    changed,
    entry: changed ? merged : existing,
  };
}

function buildAssessmentIdentity(assessment, fallbackCourseInstanceId, origin) {
  if (!assessment || typeof assessment !== "object") {
    return null;
  }

  const courseInstanceId = String(
    assessment.courseInstanceId || fallbackCourseInstanceId || ""
  ).trim();
  if (!/^\d+$/.test(courseInstanceId)) {
    return null;
  }

  const absoluteUrlCandidate =
    typeof assessment.absoluteUrl === "string" && assessment.absoluteUrl.trim()
      ? assessment.absoluteUrl
      : null;
  const hrefCandidate =
    typeof assessment.href === "string" && assessment.href.trim() ? assessment.href : null;

  const normalizedHref = normalizeAssessmentHref(
    absoluteUrlCandidate || hrefCandidate,
    origin || null
  );
  const titleKey = normalizeWhitespace(assessment.title || "").toLowerCase();
  const badgeKey = normalizeWhitespace(assessment.badge || "").toLowerCase();
  const groupKey = normalizeWhitespace(assessment.group || "").toLowerCase();
  const fallbackKey = `title:${titleKey}|badge:${badgeKey}|group:${groupKey}`;
  const keyPart = normalizedHref || fallbackKey;

  if (!keyPart || keyPart === "title:|badge:|group:") {
    return null;
  }

  return {
    pinId: `${courseInstanceId}|${keyPart}`,
    courseInstanceId,
    href: hrefCandidate,
    absoluteUrl: absoluteUrlCandidate,
  };
}

function normalizeAssessmentHref(href, origin) {
  if (typeof href !== "string" || !href.trim()) {
    return null;
  }

  const normalizedOrigin = normalizePrairieLearnOrigin(origin) || "https://us.prairielearn.com";

  try {
    const url = new URL(href, normalizedOrigin);
    return `${url.pathname}${url.search}`.toLowerCase();
  } catch {
    return normalizeWhitespace(href).toLowerCase();
  }
}

function isDueDateInPast(dueAtIso, nowMs = Date.now()) {
  const normalized = normalizeIsoTimestamp(dueAtIso);
  if (!normalized) {
    return false;
  }

  const dueMs = Date.parse(normalized);
  if (Number.isNaN(dueMs)) {
    return false;
  }

  return dueMs <= nowMs;
}

function normalizeIsoTimestamp(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const time = Date.parse(value);
  if (Number.isNaN(time)) {
    return null;
  }

  return new Date(time).toISOString();
}

async function buildDashboardData() {
  const all = await chrome.storage.local.get(null);
  const meta = all[STORAGE_META_KEY] || null;
  let pinnedById = sanitizePinnedAssessmentStore(all[STORAGE_PINNED_KEY]);
  let pinnedStoreChanged = false;
  const nowMs = Date.now();

  const snapshots = Object.entries(all)
    .filter(([key]) => key.startsWith(STORAGE_COURSE_PREFIX))
    .map(([, value]) => value)
    .filter((value) => value && Array.isArray(value.assessments));

  const upcoming = [];
  let assessmentCount = 0;
  let pinnedCount = 0;

  for (const [pinId, pin] of Object.entries(pinnedById)) {
    if (isDueDateInPast(pin?.dueAt, nowMs)) {
      delete pinnedById[pinId];
      pinnedStoreChanged = true;
    }
  }

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

      const identity = buildAssessmentIdentity(
        assessment,
        snapshot.courseInstanceId,
        snapshot.origin
      );

      const pinId = identity?.pinId || null;
      const existingPin = pinId ? pinnedById[pinId] : null;
      let isPinned = Boolean(existingPin);

      if (isPinned) {
        const latestDueAt = normalizeIsoTimestamp(assessment.dueAt) || existingPin.dueAt || null;
        if (isDueDateInPast(latestDueAt, nowMs)) {
          delete pinnedById[pinId];
          pinnedStoreChanged = true;
          isPinned = false;
        } else {
          const merged = mergePinEntryWithAssessment(existingPin, assessment, identity);
          if (merged.changed) {
            pinnedById[pinId] = merged.entry;
            pinnedStoreChanged = true;
          }
          pinnedCount += 1;
        }
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
        pinId,
        isPinned,
        capturedAt: assessment.capturedAt || snapshot.updatedAt || null,
      });
    }
  }

  if (pinnedStoreChanged) {
    await chrome.storage.local.set({ [STORAGE_PINNED_KEY]: pinnedById });
  }

  upcoming.sort(compareUpcomingAssessments);

  return {
    meta,
    stats: {
      courseSnapshots: snapshots.length,
      assessments: assessmentCount,
      upcoming: upcoming.length,
      pinned: pinnedCount,
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
