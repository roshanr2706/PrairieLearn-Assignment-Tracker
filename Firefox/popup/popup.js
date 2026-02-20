const refreshButton = document.getElementById("refreshBtn");
const openHomeButton = document.getElementById("openHomeBtn");
const statusLine = document.getElementById("statusLine");
const metaLine = document.getElementById("metaLine");
const upcomingBody = document.getElementById("upcomingBody");
const emptyState = document.getElementById("emptyState");

let latestOrigin = null;

refreshButton.addEventListener("click", async () => {
  setBusy(true, "Refreshing PrairieLearn data...");
  try {
    const response = await sendMessage({ type: "PL_REFRESH_REQUEST" });
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

openHomeButton.addEventListener("click", () => {
  const origin = latestOrigin || "https://us.prairielearn.com";
  chrome.tabs.create({ url: `${origin}/` });
});

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

function renderDashboard(data) {
  const meta = data?.meta || null;
  const upcoming = Array.isArray(data?.upcoming) ? data.upcoming : [];
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
  const upcomingCount = stats.upcoming || 0;
  metaLine.textContent = `${courseCount} courses synced, ${totalAssessments} assessments parsed, ${upcomingCount} upcoming`;

  upcomingBody.innerHTML = "";
  if (!upcoming.length) {
    emptyState.textContent = meta?.origin
      ? "No upcoming assessments found. Try refreshing after visiting your course pages."
      : "No PrairieLearn data found yet. Open PrairieLearn home page and click Refresh.";
    emptyState.classList.remove("hidden");
    return;
  }

  emptyState.classList.add("hidden");
  for (const item of upcoming) {
    const row = document.createElement("tr");
    row.appendChild(renderCourseCell(item));
    row.appendChild(renderAssessmentCell(item));
    row.appendChild(renderDueCell(item));
    row.appendChild(renderStatusCell(item));
    upcomingBody.appendChild(row);
  }
}

function renderCourseCell(item) {
  const cell = document.createElement("td");
  cell.textContent = item.courseLabel || "Course";
  return cell;
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
  cell.textContent = item.dueAt ? formatDateTime(item.dueAt) : "No due date";

  if (!item.dueAt && item.availabilityText) {
    const sub = document.createElement("span");
    sub.className = "sub";
    sub.textContent = item.availabilityText;
    cell.appendChild(sub);
  }

  return cell;
}

function renderStatusCell(item) {
  const cell = document.createElement("td");
  const pill = document.createElement("span");
  pill.className = "status-pill";

  if (item.score) {
    pill.textContent = item.score;
    pill.classList.add("good");
  } else {
    const label = statusToLabel(item.status);
    pill.textContent = label;
    if (item.status === "not_started" || item.status === "action_available") {
      pill.classList.add("warn");
    }
  }

  cell.appendChild(pill);
  return cell;
}

function statusToLabel(status) {
  if (status === "not_started") {
    return "Not started";
  }
  if (status === "action_available") {
    return "Action available";
  }
  if (status === "scored") {
    return "Scored";
  }
  if (status === "text_status") {
    return "In progress";
  }
  return "Unknown";
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
