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
  // Node globals the builder uses that a bare vm context doesn't have.
  URL,
  TextEncoder,
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
  assert.ok(ics.includes("PRODID:-//Better PrairieLearn//Assessment Deadlines//EN"));
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

// Unfold RFC 5545 continuation lines so assertions can match whole properties.
const unfold = (ics) => ics.replace(/\r\n /g, "");

test("buildAssessmentIcs keys UIDs on the assessment, not its deadline", () => {
  const base = {
    courseInstanceId: "123",
    courseLabel: "CPSC 313",
    badge: "HW 1",
    title: "Pointers",
    href: "/pl/course_instance/123/assessment/456/",
    pinId: "123|/pl/course_instance/123/assessment/456/",
  };
  const uidOf = (ics) => ics.match(/^UID:(.*)$/m)[1];

  const before = buildAssessmentIcs([{ ...base, dueAt: "2026-09-15T23:59:00Z" }], "https://us.prairielearn.com", fixedNow);
  const extended = buildAssessmentIcs([{ ...base, dueAt: "2026-09-18T23:59:00Z" }], "https://us.prairielearn.com", fixedNow);

  assert.equal(uidOf(before), uidOf(extended));
  assert.equal(uidOf(before), "pl-123-pl-course-instance-123-assessment-456@prairielearn-tracker");
});

test("buildAssessmentIcs exports PrairieTest exams as real start/end sessions", () => {
  const ics = unfold(
    buildAssessmentIcs(
      [
        {
          isPrairieTest: true,
          id: "abc123",
          title: "Midterm 1",
          dueAt: "2026-09-20T17:00:00Z",
          startDate: "2026-09-20T17:00:00Z",
          endDate: "2026-09-20T18:15:00Z",
          location: "ICCS 005",
          href: "https://us.prairietest.com/pt/reservation/abc123",
        },
      ],
      "https://us.prairielearn.com",
      fixedNow
    )
  );

  // Same UID as prairietest-content.js uses, so the two exports don't duplicate.
  assert.ok(ics.includes("UID:pt-abc123@prairietest-tracker"));
  assert.ok(ics.includes("DTSTART:20260920T170000Z"));
  assert.ok(ics.includes("DTEND:20260920T181500Z"));
  assert.ok(ics.includes("SUMMARY:Exam: Midterm 1"));
  assert.ok(ics.includes("LOCATION:ICCS 005"));
  assert.ok(!ics.includes("SUMMARY:Due:"));
});

test("buildAssessmentIcs folds long lines at 75 octets without splitting characters", () => {
  const ics = buildAssessmentIcs(
    [
      {
        courseInstanceId: "123",
        courseLabel: "CPSC 313",
        badge: "HW 1",
        title: "Café ☕ ".repeat(20),
        dueAt: "2026-09-15T23:59:00Z",
      },
    ],
    "https://us.prairielearn.com",
    fixedNow
  );

  for (const line of ics.split("\r\n")) {
    assert.ok(Buffer.byteLength(line, "utf8") <= 75, `line too long: ${line}`);
  }
  assert.ok(ics.includes("\r\n "));
  assert.ok(unfold(ics).includes("Café ☕ Café"));
});
