const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const bgSource = fs.readFileSync("Chrome/background.js", "utf8");

// Minimal sandbox to extract buildAssessmentIcs
const context = {};
context.globalThis = context;
Object.assign(context, {
  Date,
  Number,
  String,
  Math,
  Array,
  Boolean,
  parseFloat,
  parseInt: Number.parseInt,
  chrome: {
    runtime: {
      onInstalled: { addListener: () => {} },
      onMessage: { addListener: () => {} },
    },
    storage: {
      local: {
        get: () => {},
        set: () => {},
      },
    },
  },
});

vm.createContext(context);
vm.runInContext(
  bgSource + "\n;globalThis.__TEST_EXPORTS__ = { buildAssessmentIcs };",
  context
);

const { buildAssessmentIcs } = context.globalThis.__TEST_EXPORTS__;

const fixedNow = new Date("2026-09-10T12:00:00Z").getTime();

test("buildAssessmentIcs generates valid VCALENDAR with VEVENT and VALARM", () => {
  const items = [
    {
      courseInstanceId: "123",
      courseLabel: "CPSC 313",
      badge: "HW 1",
      title: "Pointers & Memory",
      dueAt: "2026-09-15T23:59:00Z",
      href: "/pl/course_instance/123/assessment/456",
      group: "Homework",
    },
  ];

  const ics = buildAssessmentIcs(items, "https://us.prairielearn.com", fixedNow);

  assert.ok(ics.startsWith("BEGIN:VCALENDAR"));
  assert.ok(ics.includes("VERSION:2.0"));
  assert.ok(ics.includes("PRODID:-//PrairieLearn Tracker//Assessment Deadlines//EN"));
  assert.ok(ics.includes("BEGIN:VEVENT"));
  assert.ok(ics.includes("SUMMARY:Due: CPSC 313 - HW 1 - Pointers & Memory"));
  assert.ok(ics.includes("DTEND:20260915T235900Z"));
  assert.ok(ics.includes("DTSTART:20260915T225900Z"));
  assert.ok(ics.includes("BEGIN:VALARM"));
  assert.ok(ics.includes("TRIGGER:-PT24H"));
  assert.ok(ics.includes("TRIGGER:-PT2H"));
  assert.ok(ics.includes("END:VALARM"));
  assert.ok(ics.includes("END:VEVENT"));
  assert.ok(ics.includes("END:VCALENDAR"));
});

test("buildAssessmentIcs handles multiple items and ignores items with invalid dueAt", () => {
  const items = [
    {
      courseInstanceId: "123",
      courseLabel: "CPSC 313",
      badge: "HW 1",
      title: "Item 1",
      dueAt: "2026-09-15T20:00:00Z",
    },
    {
      courseInstanceId: "123",
      courseLabel: "CPSC 313",
      badge: "HW 2",
      title: "Invalid Item",
      dueAt: "invalid-date",
    },
    {
      courseInstanceId: "123",
      courseLabel: "CPSC 313",
      badge: "HW 3",
      title: "Item 3",
      dueAt: "2026-09-20T20:00:00Z",
    },
  ];

  const ics = buildAssessmentIcs(items, "https://us.prairielearn.com", fixedNow);

  const eventCount = (ics.match(/BEGIN:VEVENT/g) || []).length;
  assert.equal(eventCount, 2);
  assert.ok(ics.includes("Item 1"));
  assert.ok(!ics.includes("Invalid Item"));
  assert.ok(ics.includes("Item 3"));
});
