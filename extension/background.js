// The demo's background script (an event page in Firefox MV3). The E2E test
// reads this value back through popup.html. Replace it with code that runs
// foxbench.
browser.runtime.onInstalled.addListener(() => {
  browser.storage.local.set({ fixture: "installed" });
});
