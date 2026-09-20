// badge-override.js — content script
// Injects CSS to restore classic solid-color badge style (pre-2025)
// when pl.settings.classic_badges is enabled.

const CLASSIC_BADGES_KEY = "pl.settings.classic_badges";
const STYLE_ID = "pl-classic-badges";

const CLASSIC_CSS = `
.badge.color-red1      { color:#000!important; background-color:#ffccbc!important; border-color:#ffccbc!important; }
.badge.color-red2      { color:#000!important; background-color:#ff6c5c!important; border-color:#ff6c5c!important; }
.badge.color-red3      { color:#fff!important; background-color:#c72c1c!important; border-color:#c72c1c!important; }
.badge.color-pink1     { color:#000!important; background-color:#ffbcd8!important; border-color:#ffbcd8!important; }
.badge.color-pink2     { color:#000!important; background-color:#fa5c98!important; border-color:#fa5c98!important; }
.badge.color-pink3     { color:#fff!important; background-color:#ba1c58!important; border-color:#ba1c58!important; }
.badge.color-purple1   { color:#000!important; background-color:#dcc6e0!important; border-color:#dcc6e0!important; }
.badge.color-purple2   { color:#fff!important; background-color:#9b59b6!important; border-color:#9b59b6!important; }
.badge.color-purple3   { color:#fff!important; background-color:#5e147d!important; border-color:#5e147d!important; }
.badge.color-blue1     { color:#000!important; background-color:#39d5ff!important; border-color:#39d5ff!important; }
.badge.color-blue2     { color:#000!important; background-color:#1297e0!important; border-color:#1297e0!important; }
.badge.color-blue3     { color:#fff!important; background-color:#0057a0!important; border-color:#0057a0!important; }
.badge.color-turquoise1{ color:#000!important; background-color:#5efaf7!important; border-color:#5efaf7!important; }
.badge.color-turquoise2{ color:#000!important; background-color:#27cbc0!important; border-color:#27cbc0!important; }
.badge.color-turquoise3{ color:#fff!important; background-color:#008b80!important; border-color:#008b80!important; }
.badge.color-green1    { color:#000!important; background-color:#8effc1!important; border-color:#8effc1!important; }
.badge.color-green2    { color:#000!important; background-color:#2ecc71!important; border-color:#2ecc71!important; }
.badge.color-green3    { color:#fff!important; background-color:#008c31!important; border-color:#008c31!important; }
.badge.color-yellow1   { color:#000!important; background-color:#fde3a7!important; border-color:#fde3a7!important; }
.badge.color-yellow2   { color:#000!important; background-color:#f5ab35!important; border-color:#f5ab35!important; }
.badge.color-yellow3   { color:#fff!important; background-color:#d87400!important; border-color:#d87400!important; }
.badge.color-orange1   { color:#000!important; background-color:#ffdcb5!important; border-color:#ffdcb5!important; }
.badge.color-orange2   { color:#000!important; background-color:#ff926b!important; border-color:#ff926b!important; }
.badge.color-orange3   { color:#fff!important; background-color:#c3522b!important; border-color:#c3522b!important; }
.badge.color-brown1    { color:#000!important; background-color:#f6c4a3!important; border-color:#f6c4a3!important; }
.badge.color-brown2    { color:#000!important; background-color:#ce9c7b!important; border-color:#ce9c7b!important; }
.badge.color-brown3    { color:#fff!important; background-color:#8e5c3b!important; border-color:#8e5c3b!important; }
.badge.color-gray1     { color:#000!important; background-color:#e0e0e0!important; border-color:#e0e0e0!important; }
.badge.color-gray2     { color:#000!important; background-color:#909090!important; border-color:#909090!important; }
.badge.color-gray3     { color:#fff!important; background-color:#505050!important; border-color:#505050!important; }
`;

function applyClassicBadges() {
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CLASSIC_CSS;
    document.head.appendChild(style);
  }
}

function removeClassicBadges() {
  const existing = document.getElementById(STYLE_ID);
  if (existing) existing.remove();
}

chrome.storage.local.get(CLASSIC_BADGES_KEY, (result) => {
  if (result[CLASSIC_BADGES_KEY]) applyClassicBadges();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !(CLASSIC_BADGES_KEY in changes)) return;
  if (changes[CLASSIC_BADGES_KEY].newValue) {
    applyClassicBadges();
  } else {
    removeClassicBadges();
  }
});
