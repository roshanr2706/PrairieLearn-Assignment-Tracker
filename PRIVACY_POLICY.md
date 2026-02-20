# PrairieLearn Tracker Privacy Policy

Last updated: February 20, 2026

PrairieLearn Tracker is a Chrome extension that helps users view upcoming PrairieLearn assessments.

## Data this extension accesses

The extension accesses PrairieLearn page content on `https://*.prairielearn.com/*` to read:

- enrolled course identifiers
- assessment titles
- due dates / access windows
- score/progress status

## How data is used

Data is used only to provide the extension's single purpose:

- show upcoming, incomplete assessments
- render the extension popup dashboard
- render the homepage "Upcoming" card

## Data storage

Parsed course/assessment data is stored locally in the browser using `chrome.storage.local`.

## Data sharing

- No user data is sold.
- No user data is transferred to third parties.
- No external analytics or ad SDKs are used.

## Remote code

The extension does not use remote code. All executable JavaScript is packaged with the extension.

## Security

The extension only requests permissions needed to function:

- `storage`
- `tabs`
- host access to `https://*.prairielearn.com/*`
