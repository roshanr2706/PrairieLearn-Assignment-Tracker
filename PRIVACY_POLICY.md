# Better PrairieLearn Privacy Policy

Last updated: October 5, 2026

Better PrairieLearn is a browser extension for Chrome and Firefox that adds an upcoming-assessments dashboard and study tools to PrairieLearn and PrairieTest.

## Data this extension accesses

The extension reads page content, using your existing logged-in session, on:

- `https://*.prairielearn.com/*`: enrolled course identifiers and names, assessment titles, groups, due dates and access windows, scores and progress, gradebook scores, and question text on assessments you open.
- `https://us.prairietest.com/*`: your exam reservations (exam, date, time, duration, location) and exams that still need a reservation.

The extension never reads or stores your password.

## How data is used

Data is used only to provide the extension's features:

- show upcoming, incomplete assessments and PrairieTest exams in the popup and on the PrairieLearn home page
- let you pin assessments, filter the assessments page, and estimate grades in the gradebook calculator
- export deadlines and exams to a calendar file (`.ics`) that is saved to your computer
- copy question text or a screenshot of a question to your clipboard when you click the matching button

## Data storage

Parsed course, assessment, reservation and settings data is stored locally in your browser using the extension storage API (`chrome.storage.local`). It never leaves your device unless you take one of the actions below.

## Data sharing

- No user data is sold.
- No user data is sent to the developer or any server operated by the developer.
- No analytics, tracking or advertising code is used.
- If you click "Google Calendar" or "Outlook Web" on a PrairieTest reservation, the exam's title, time and location are passed to Google or Microsoft in the link that opens, so that service can create the event. This only happens when you click one of those buttons.

## Remote code

The extension does not use remote code. All executable JavaScript is packaged with the extension.

## Permissions

- `storage`: save dashboard data and your settings locally
- `tabs`: find or open a PrairieLearn tab to refresh data, and open the welcome page
- `scripting`: reload the extension's script in a PrairieLearn tab if it is not responding during a refresh
- `offscreen` (Chrome only): parse fetched PrairieLearn pages, since Chrome's background worker has no HTML parser
- host access to `https://*.prairielearn.com/*` and `https://us.prairietest.com/*`: read the pages listed above

## Contact

Questions about this policy can be raised at https://github.com/roshanr2706/PrairieLearn-Assignment-Tracker/issues.
