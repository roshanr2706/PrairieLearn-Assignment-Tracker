// Injects [+ GCal] links into the "Exam reservations" section on us.prairietest.com/pt

function parseDurationToMinutes(text) {
  let minutes = 0;
  const hours = text.match(/(\d+)\s*h/);
  const mins = text.match(/(\d+)\s*min/);
  if (hours) minutes += parseInt(hours[1]) * 60;
  if (mins) minutes += parseInt(mins[1]);
  return minutes;
}

function toGCalDate(isoUtc) {
  // Convert "2026-03-09T22:00:00.000Z" to "20260309T220000Z"
  return isoUtc.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function addMinutesToIso(isoUtc, minutes) {
  const date = new Date(isoUtc);
  date.setMinutes(date.getMinutes() + minutes);
  return date.toISOString();
}

function buildGCalUrl(title, startIso, durationMinutes, location) {
  const endIso = addMinutesToIso(startIso, durationMinutes);
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: title,
    dates: `${toGCalDate(startIso)}/${toGCalDate(endIso)}`,
    location: location,
    details: "PrairieTest reservation",
  });
  return `https://www.google.com/calendar/render?${params.toString()}`;
}

function injectGCalLinks() {
  // Find the "Exam reservations" card (not "available for reservations", not "past")
  const cards = document.querySelectorAll(".card");
  let reservationsCard = null;
  for (const card of cards) {
    const heading = card.querySelector("h2");
    if (heading && heading.textContent.trim() === "Exam reservations") {
      reservationsCard = card;
      break;
    }
  }
  if (!reservationsCard) return;

  const items = reservationsCard.querySelectorAll("li.list-group-item");
  for (const item of items) {
    const examEl = item.querySelector("[data-testid='exam']");
    const dateEl = item.querySelector("[data-testid='date']");
    const locationEl = item.querySelector("[data-testid='location']");
    // Last col div holds duration/type/accommodations text
    const cols = item.querySelectorAll(".row > div");
    const lastCol = cols[cols.length - 1];

    if (!examEl || !dateEl || !lastCol) continue;

    const dateSpan = dateEl.querySelector(".js-format-date-friendly-live-update");
    if (!dateSpan || !dateSpan.dataset.formatDate) continue;

    let startIso;
    try {
      startIso = JSON.parse(dateSpan.dataset.formatDate).date;
    } catch (e) {
      continue;
    }

    const title = examEl.textContent.trim();
    const durationText = lastCol.textContent.trim();
    const durationMinutes = parseDurationToMinutes(durationText);
    const location = locationEl ? locationEl.textContent.trim().replace(/\s+/g, " ") : "";

    if (!durationMinutes) continue;

    const gcalUrl = buildGCalUrl(title, startIso, durationMinutes, location);

    const link = document.createElement("a");
    link.href = gcalUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "+ GCal";
    link.style.cssText =
      "font-size:0.75em;margin-left:0.5em;white-space:nowrap;vertical-align:middle;";
    link.className = "btn btn-outline-secondary btn-sm py-0 px-1";

    dateSpan.insertAdjacentElement("afterend", link);
  }
}

injectGCalLinks();
