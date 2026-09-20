const CLASSIC_BADGES_KEY = "pl.settings.classic_badges";

chrome.storage.local.get(CLASSIC_BADGES_KEY, (result) => {
  document.getElementById("classicBadgesToggle").checked = !!result[CLASSIC_BADGES_KEY];
});

document.getElementById("classicBadgesToggle").addEventListener("change", (e) => {
  chrome.storage.local.set({ [CLASSIC_BADGES_KEY]: e.target.checked });
});

document.getElementById("startBtn").addEventListener("click", () => {
  window.close();
});
