const refreshButton = document.getElementById("refreshBtn");
const openHomeButton = document.getElementById("openHomeBtn");
const optionsButton = document.getElementById("optionsBtn");
const optionsPanel = document.getElementById("optionsPanel");
const classicBadgesToggle = document.getElementById("classicBadgesToggle");
const filterToolbarToggle = document.getElementById("filterToolbarToggle");
const homeMaxUpcomingRange = document.getElementById("homeMaxUpcomingRange");
const homeMaxUpcomingValue = document.getElementById("homeMaxUpcomingValue");
const statusLine = document.getElementById("statusLine");
const metaLine = document.getElementById("metaLine");
const upcomingBody = document.getElementById("upcomingBody");
const emptyState = document.getElementById("emptyState");
const unreservedPanel = document.getElementById("unreservedPanel");

const CLASSIC_BADGES_KEY = "pl.settings.classic_badges";
const FILTER_TOOLBAR_KEY = "pl.settings.filter_toolbar";
// 0 or unset means no limit; the slider's last stop (21) stands for "All".
const HOME_MAX_UPCOMING_KEY = "pl.settings.home_max_upcoming";
const HOME_MAX_UPCOMING_SLIDER_ALL = 21;
const COURSE_TONE_COUNT = 6;

chrome.storage.local.get([CLASSIC_BADGES_KEY, FILTER_TOOLBAR_KEY, HOME_MAX_UPCOMING_KEY], (result) => {
  classicBadgesToggle.checked = !!result[CLASSIC_BADGES_KEY];
  // On by default: only an explicit false turns the toolbar off.
  filterToolbarToggle.checked = result[FILTER_TOOLBAR_KEY] !== false;
  const max = Number(result[HOME_MAX_UPCOMING_KEY]);
  homeMaxUpcomingRange.value = String(Number.isInteger(max) && max > 0 ? max : HOME_MAX_UPCOMING_SLIDER_ALL);
  updateHomeMaxUpcomingLabel();
});

function updateHomeMaxUpcomingLabel() {
  const position = Number(homeMaxUpcomingRange.value);
  homeMaxUpcomingValue.textContent = position >= HOME_MAX_UPCOMING_SLIDER_ALL ? "All" : String(position);
}

optionsButton.addEventListener("click", () => {
  optionsPanel.classList.toggle("hidden");
});

classicBadgesToggle.addEventListener("change", (e) => {
  chrome.storage.local.set({ [CLASSIC_BADGES_KEY]: e.target.checked });
});

filterToolbarToggle.addEventListener("change", (e) => {
  chrome.storage.local.set({ [FILTER_TOOLBAR_KEY]: e.target.checked });
});

homeMaxUpcomingRange.addEventListener("input", updateHomeMaxUpcomingLabel);
homeMaxUpcomingRange.addEventListener("change", () => {
  const position = Number(homeMaxUpcomingRange.value);
  const max = position >= HOME_MAX_UPCOMING_SLIDER_ALL ? 0 : position;
  chrome.storage.local.set({ [HOME_MAX_UPCOMING_KEY]: max });
});

let latestOrigin = null;

refreshButton.addEventListener("click", async () => {
  setBusy(true, "Refreshing PrairieLearn data...");
  try {
    const payload = latestOrigin ? { origin: latestOrigin } : {};
    const response = await sendMessage({ type: "PL_REFRESH_REQUEST", payload });
    if (!response?.ok) {
      throw new Error(response?.error || "Refresh failed.");
    }
    renderDashboard(response.data);
    if (response.refreshSummary) {
      statusLine.textContent = formatRefreshSummary(response.refreshSummary);
    }
  } catch (error) {
    statusLine.textContent = `Refresh failed: ${toErrorMessage(error)}`;
  } finally {
    setBusy(false);
  }
});

const icsButton = document.getElementById("icsBtn");

openHomeButton.addEventListener("click", () => {
  const origin = latestOrigin || "https://us.prairielearn.com";
  chrome.tabs.create({ url: `${origin}/` });
});

if (icsButton) {
  icsButton.addEventListener("click", async () => {
    icsButton.disabled = true;
    const icsScopeSelect = document.getElementById("icsScopeSelect");
    const scope = icsScopeSelect?.value || "all";
    const scopeLabel = scope === "week" ? "next 7 days" : "all future";
    statusLine.textContent = `Preparing ${scopeLabel} calendar file...`;
    try {
      const response = await sendMessage({
        type: "PL_EXPORT_CALENDAR_ICS",
        payload: { scope },
      });
      if (!response?.ok || typeof response.ics !== "string") {
        throw new Error(response?.error || "Calendar file export failed.");
      }
      const blobUrl = URL.createObjectURL(new Blob([response.ics], { type: "text/calendar;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = response.filename || "prairielearn-deadlines.ics";
      // Firefox ignores clicks on detached links, and revoking the URL right
      // away can cancel the download before it starts.
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
      const countMsg = response.count ? ` (${response.count} event${response.count === 1 ? "" : "s"})` : "";
      statusLine.textContent = `Calendar file downloaded${countMsg}. Import it into your calendar app.`;
    } catch (error) {
      statusLine.textContent = `Calendar export failed: ${toErrorMessage(error)}`;
    } finally {
      icsButton.disabled = false;
    }
  });
}

void loadDashboard();

async function loadDashboard() {
  setBusy(true, "Loading dashboard...");
  try {
    const response = await sendMessage({ type: "PL_GET_DASHBOARD" });
    if (!response?.ok) {
      throw new Error(response?.error || "Failed to load dashboard.");
    }
    renderDashboard(response.data);
  } catch (error) {
    statusLine.textContent = `Failed to load: ${toErrorMessage(error)}`;
    emptyState.textContent =
      "Open your PrairieLearn home page once while logged in, then click Refresh.";
    emptyState.classList.remove("hidden");
  } finally {
    setBusy(false);
  }
}

// PrairieLearn only publishes an access window while an assessment is open, so
// a parsed dueAt is what separates real deadlines from "not open yet" and
// already-finished rows. The home card keeps the wider list for pinned items.
function isOpenWithDeadline(item) {
  const dueTime = Date.parse(item?.dueAt || "");
  if (Number.isNaN(dueTime)) {
    return false;
  }

  return dueTime >= Date.now();
}

function renderDashboard(data) {
  const meta = data?.meta || null;
  const allItems = Array.isArray(data?.upcoming) ? data.upcoming : [];
  const upcoming = allItems.filter(isOpenWithDeadline);
  const stats = data?.stats || { courseSnapshots: 0, assessments: 0, upcoming: 0 };

  latestOrigin = typeof meta?.origin === "string" ? meta.origin : null;

  if (meta?.lastError) {
    statusLine.textContent = `Last refresh warning: ${meta.lastError}`;
  } else if (meta?.lastRefreshAt) {
    statusLine.textContent = `Last refresh: ${formatDateTime(meta.lastRefreshAt)}`;
  } else {
    statusLine.textContent = "No refresh has run yet.";
  }

  const courseCount = stats.courseSnapshots || 0;
  const totalAssessments = stats.assessments || 0;
  const upcomingCount = upcoming.length;
  metaLine.textContent = `${courseCount} courses synced, ${totalAssessments} assessments parsed, ${upcomingCount} upcoming`;

  renderUnreservedPanel(data);

  upcomingBody.innerHTML = "";
  if (!upcoming.length) {
    emptyState.textContent = meta?.origin
      ? "Nothing open with a deadline right now. Assessments appear here once PrairieLearn opens them."
      : "No PrairieLearn data found yet. Open PrairieLearn home page and click Refresh.";
    emptyState.classList.remove("hidden");
    return;
  }

  emptyState.classList.add("hidden");
  const courseTones = buildCourseToneMap(upcoming);
  for (const item of upcoming) {
    const row = document.createElement("tr");
    row.className = `row-${dueUrgency(Date.parse(item.dueAt || ""))}`;
    row.appendChild(renderCourseCell(item, courseTones));
    row.appendChild(renderAssessmentCell(item));
    row.appendChild(renderDueCell(item));
    row.appendChild(renderStatusCell(item));
    upcomingBody.appendChild(row);
  }
}

// PrairieTest exams that still need a reservation drive the toolbar "!" badge,
// but the badge alone gave no way to see which exams. Surface them here so the
// popup explains the badge and links straight to the reservation page.
function renderUnreservedPanel(data) {
  if (!unreservedPanel) {
    return;
  }

  const items = Array.isArray(data?.prairietestUnreserved) ? data.prairietestUnreserved : [];
  unreservedPanel.innerHTML = "";
  if (!items.length) {
    unreservedPanel.classList.add("hidden");
    return;
  }

  const title = document.createElement("p");
  title.className = "unreserved-title";
  const count = items.length;
  title.textContent = `${count} PrairieTest exam${count > 1 ? "s need" : " needs"} a reservation`;
  unreservedPanel.appendChild(title);

  const list = document.createElement("ul");
  list.className = "unreserved-list";
  for (const item of items) {
    const row = document.createElement("li");
    const label = item.title || item.examTitle || "Exam";

    if (item.reserveUrl) {
      const link = document.createElement("a");
      link.href = item.reserveUrl;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = label;
      row.appendChild(link);
    } else {
      row.appendChild(document.createTextNode(label));
    }

    if (item.reserveDeadlineFormatted) {
      const deadline = document.createElement("span");
      deadline.className = "unreserved-deadline";
      deadline.textContent = `Reserve by ${item.reserveDeadlineFormatted}`;
      row.appendChild(deadline);
    }

    list.appendChild(row);
  }
  unreservedPanel.appendChild(list);
  unreservedPanel.classList.remove("hidden");
}

function renderCourseCell(item, courseTones) {
  const cell = document.createElement("td");
  const label = item.courseLabel || "Course";

  const chip = document.createElement("span");
  chip.className = `course-chip tone-${courseTones.get(label) ?? 0}`;
  chip.textContent = label;

  cell.appendChild(chip);
  return cell;
}

// Hand out chip colours by sorted course name rather than by hashing the label.
// Hashing collided in practice (CPSC 313 and CPSC 320 landed on the same tone),
// and sorting keeps a course on one colour as long as the course list holds.
function buildCourseToneMap(items) {
  const labels = [...new Set(items.map((item) => item.courseLabel || "Course"))].sort();

  const tones = new Map();
  labels.forEach((label, index) => {
    tones.set(label, index % COURSE_TONE_COUNT);
  });
  return tones;
}

function renderAssessmentCell(item) {
  const cell = document.createElement("td");
  const wrapper = document.createElement("div");
  wrapper.className = "assessment-title";

  if (item.badge) {
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = item.badge;
    wrapper.appendChild(badge);
  }

  const content = document.createElement("div");
  if (item.href) {
    const link = document.createElement("a");
    link.className = "assessment-link";
    link.href = item.href;
    link.textContent = item.title || "Untitled";
    link.target = "_blank";
    link.rel = "noreferrer";
    content.appendChild(link);
  } else {
    content.textContent = item.title || "Untitled";
  }

  if (item.group) {
    const group = document.createElement("span");
    group.className = "sub";
    group.textContent = item.group;
    content.appendChild(group);
  }

  wrapper.appendChild(content);
  cell.appendChild(wrapper);
  return cell;
}

function renderDueCell(item) {
  const cell = document.createElement("td");
  const dueTime = Date.parse(item.dueAt || "");

  if (Number.isNaN(dueTime)) {
    cell.textContent = "No due date";
    if (item.availabilityText) {
      const sub = document.createElement("span");
      sub.className = "sub";
      sub.textContent = item.availabilityText;
      cell.appendChild(sub);
    }
    return cell;
  }

  cell.classList.add(`due-${dueUrgency(dueTime)}`);

  const absolute = document.createElement("span");
  absolute.className = "due-absolute";
  absolute.textContent = formatDateTime(item.dueAt);
  cell.appendChild(absolute);

  const relative = document.createElement("span");
  relative.className = "sub due-relative";
  relative.textContent = formatRelativeDue(dueTime);
  cell.appendChild(relative);

  return cell;
}

function dueUrgency(dueTime) {
  if (Number.isNaN(dueTime)) {
    return "none";
  }

  const hoursAway = (dueTime - Date.now()) / 3600000;
  if (hoursAway < 0) {
    return "overdue";
  }
  if (hoursAway <= 24) {
    return "urgent";
  }
  if (hoursAway <= 72) {
    return "soon";
  }
  return "later";
}

function formatRelativeDue(dueTime) {
  const diffMs = dueTime - Date.now();
  if (diffMs < 0) {
    return "Overdue";
  }

  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 60) {
    return `in ${Math.max(minutes, 1)} min`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `in ${hours} h`;
  }

  const days = Math.floor(hours / 24);
  return days === 1 ? "in 1 day" : `in ${days} days`;
}

function renderStatusCell(item) {
  const cell = document.createElement("td");
  const percent = parseScorePercent(item.score);

  const progressContainer = document.createElement("div");
  progressContainer.className = "pl-progress";

  let fillPercent = 0;
  let colorClass = "secondary";
  let label = "";

  if (percent !== null) {
    fillPercent = Math.min(percent, 100);
    if (percent >= 100) {
      colorClass = "success";
    } else if (percent >= 50) {
      colorClass = "primary";
    } else if (percent > 0) {
      colorClass = "warning";
    } else {
      colorClass = "secondary";
    }
    label = `${percent}%`;
  }

  progressContainer.classList.add(`border-${colorClass}`);

  const fill = document.createElement("div");
  fill.className = `pl-progress-fill bg-${colorClass}`;
  fill.style.width = `${fillPercent}%`;
  if (label && fillPercent >= 15) {
    fill.textContent = label;
  }
  progressContainer.appendChild(fill);

  const remainder = document.createElement("div");
  remainder.className = "pl-progress-remainder";
  remainder.style.width = `${100 - fillPercent}%`;
  if (percent === null) {
    // A non-percent score (e.g. a PrairieTest exam's "1h 15m In-person") should
    // still show, matching the home card, rather than collapsing to a status.
    remainder.textContent = item.score ? item.score : statusToLabel(item.status);
  } else if (label && fillPercent < 15) {
    remainder.textContent = label;
  }
  progressContainer.appendChild(remainder);

  cell.appendChild(progressContainer);
  return cell;
}

function parseScorePercent(score) {
  if (typeof score !== "string") {
    return null;
  }
  const match = score.match(/(\d+(?:\.\d+)?)\s*%/);
  if (!match) {
    return null;
  }
  const value = parseFloat(match[1]);
  return Number.isNaN(value) ? null : Math.round(value * 10) / 10;
}

function statusToLabel(status) {
  if (status === "not_started") {
    return "Not started";
  }
  if (status === "action_available") {
    return "Start";
  }
  if (status === "scored") {
    return "Scored";
  }
  if (status === "text_status") {
    return "In progress";
  }
  return "—";
}

function formatDateTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "Invalid date";
  }

  return date.toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatRefreshSummary(summary) {
  const succeeded = summary?.succeeded ?? 0;
  const failed = summary?.failed ?? 0;
  const total = summary?.requestedCourseCount ?? succeeded + failed;
  const mode = summary?.mode === "page_context" ? " (page context)" : "";
  const base = `Refreshed ${succeeded}/${total} courses${failed ? `, ${failed} failed` : ""}${mode}.`;
  if (!failed || !Array.isArray(summary?.errors) || summary.errors.length === 0) {
    return base;
  }

  const details = summary.errors
    .slice(0, 2)
    .map((entry) => `${entry?.courseInstanceId || "?"}: ${entry?.error || "Unknown failure"}`)
    .join(" | ");
  const suffix = summary.errors.length > 2 ? ` (+${summary.errors.length - 2} more)` : "";
  return `${base} ${details}${suffix}`;
}

function setBusy(isBusy, message) {
  refreshButton.disabled = isBusy;
  if (isBusy && message) {
    statusLine.textContent = message;
  }
}

function sendMessage(message) {
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
