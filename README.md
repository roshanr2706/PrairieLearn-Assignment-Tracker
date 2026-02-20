# PrairieLearn Tracker (Chrome Extension)

Track upcoming PrairieLearn assessments directly on your PrairieLearn home page.

## What this extension does

- Adds an **Upcoming** section above your **Courses** card on `https://*.prairielearn.com/`
- Shows only assessments that are:
  - due within the next **14 days**
  - **not at 100%** yet
- Keeps the list updated automatically when you open the PrairieLearn home page
- Includes a popup dashboard if you want a full list view


## First run

1. Log in to PrairieLearn
2. Open your home page: `https://us.prairielearn.com/` (or your PrairieLearn subdomain home)
3. Wait a few seconds for the **Upcoming** card to populate

## Daily use

- Just open PrairieLearn home and the card refreshes automatically.
- You can still open the extension popup for a broader dashboard view.
- The card’s **Refresh** button is available if you want to force an update immediately.

## Troubleshooting

- If no items appear:
  1. Confirm you are logged in to PrairieLearn
  2. Open the PrairieLearn home page (not just a course page)
  3. Wait a few seconds, then reload the page once
- If data seems stale:
  1. Click the card **Refresh** button

## Privacy

- Data is stored locally in your browser (`chrome.storage.local`)
- The extension only requests PrairieLearn domain access: `https://*.prairielearn.com/*`
- No external server is required
