const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

// Extract helper functions from Chrome/home-content.js into a test context
const contentSource = fs.readFileSync("Chrome/home-content.js", "utf8");

// Set up minimal context for home-content
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
  MutationObserver: class {
    observe() {}
    disconnect() {}
  },
  chrome: {
    runtime: {
      onMessage: { addListener: () => {} },
    },
    storage: {
      local: {
        get: () => {},
        set: () => {},
      },
    },
  },
  setTimeout,
  clearTimeout,
  window: {
    setTimeout,
    clearTimeout,
    location: {
      hostname: "us.prairielearn.com",
      pathname: "/pl/course_instance/123/assessments",
      origin: "https://us.prairielearn.com",
    },
  },
  document: {
    documentElement: {},
    querySelector: () => null,
  },
});

vm.createContext(context);
vm.runInContext(
  contentSource +
    "\n;globalThis.__TEST_EXPORTS__ = { isAssessment100PercentCompleted, matchesAssessmentSearch, isAssessmentActiveOrDueSoon, filterAssessmentItem };",
  context
);

const { isAssessment100PercentCompleted, matchesAssessmentSearch, isAssessmentActiveOrDueSoon, filterAssessmentItem } =
  context.globalThis.__TEST_EXPORTS__;

const now = new Date("2026-09-10T12:00:00Z").getTime();

test("isAssessment100PercentCompleted detects complete scores and bonus credit", () => {
  assert.equal(isAssessment100PercentCompleted("100%"), true);
  assert.equal(isAssessment100PercentCompleted("100.0%"), true);
  assert.equal(isAssessment100PercentCompleted("105%"), true);
  assert.equal(isAssessment100PercentCompleted("99.9%"), false);
  assert.equal(isAssessment100PercentCompleted("0%"), false);
  assert.equal(isAssessment100PercentCompleted("Not started"), false);
  assert.equal(isAssessment100PercentCompleted(null), false);
  assert.equal(isAssessment100PercentCompleted(undefined), false);
});

test("matchesAssessmentSearch performs case-insensitive text matching", () => {
  const item = {
    title: "Graph Traversal BFS & DFS",
    badge: "HW 4",
    group: "Homework Assignments",
    searchableText: "HW 4 Graph Traversal BFS & DFS 100% until Sep 15",
  };

  assert.equal(matchesAssessmentSearch(item, ""), true);
  assert.equal(matchesAssessmentSearch(item, "   "), true);
  assert.equal(matchesAssessmentSearch(item, "graph"), true);
  assert.equal(matchesAssessmentSearch(item, "HW 4"), true);
  assert.equal(matchesAssessmentSearch(item, "hw 4"), true);
  assert.equal(matchesAssessmentSearch(item, "assignments"), true);
  assert.equal(matchesAssessmentSearch(item, "binary tree"), false);
});

test("isAssessmentActiveOrDueSoon accurately classifies active and upcoming assessments", () => {
  // 1. Open with deadline within 14 days -> active/due soon
  const dueIn3Days = {
    dueAt: "2026-09-13T12:00:00Z",
    status: "open",
  };
  assert.equal(isAssessmentActiveOrDueSoon(dueIn3Days, now), true);

  // 2. Open with deadline beyond 14 days (e.g. 20 days) -> not due soon
  const dueIn20Days = {
    dueAt: "2026-09-30T12:00:00Z",
    status: "open",
  };
  assert.equal(isAssessmentActiveOrDueSoon(dueIn20Days, now), false);

  // 3. Past deadline -> not active/due soon
  const pastDue = {
    dueAt: "2026-09-08T12:00:00Z",
    status: "open",
  };
  assert.equal(isAssessmentActiveOrDueSoon(pastDue, now), false);

  // 4. Closed assessment -> not active
  const closed = {
    dueAt: "2026-09-13T12:00:00Z",
    status: "closed",
  };
  assert.equal(isAssessmentActiveOrDueSoon(closed, now), false);

  // 5. Unpublished / Available in future only -> not active
  const futureAvailable = {
    availabilityText: "Available 08:00, Thu, Sep 17",
    status: "open",
  };
  assert.equal(isAssessmentActiveOrDueSoon(futureAvailable, now), false);

  // 6. Unknown / indeterminate row -> fails open (returns true)
  assert.equal(isAssessmentActiveOrDueSoon({}, now), true);
  assert.equal(isAssessmentActiveOrDueSoon(null, now), true);
});

test("filterAssessmentItem composes search, completion, and due soon predicates", () => {
  const item1 = {
    badge: "HW 1",
    title: "C Pointers",
    score: "100%",
    dueAt: "2026-09-12T12:00:00Z",
    status: "open",
  };
  const item2 = {
    badge: "HW 2",
    title: "Assembly Basics",
    score: "45%",
    dueAt: "2026-09-13T12:00:00Z",
    status: "open",
  };
  const item3 = {
    badge: "HW 3",
    title: "Memory Hierarchy",
    score: "0%",
    dueAt: "2026-10-15T12:00:00Z",
    status: "open",
  };

  const items = [item1, item2, item3];

  // No filters -> all visible
  assert.deepEqual(
    items.filter((i) => filterAssessmentItem(i, {}, { now })),
    [item1, item2, item3]
  );

  // Hide completed -> excludes item1
  assert.deepEqual(
    items.filter((i) => filterAssessmentItem(i, { hideCompleted: true }, { now })),
    [item2, item3]
  );

  // Only active / due soon (14 days) -> excludes item3 (>14 days)
  assert.deepEqual(
    items.filter((i) => filterAssessmentItem(i, { onlyActiveDueSoon: true }, { now })),
    [item1, item2]
  );

  // Query search
  assert.deepEqual(
    items.filter((i) => filterAssessmentItem(i, { query: "Assembly" }, { now })),
    [item2]
  );

  // Combined: hide completed AND due soon
  assert.deepEqual(
    items.filter((i) => filterAssessmentItem(i, { hideCompleted: true, onlyActiveDueSoon: true }, { now })),
    [item2]
  );
});
