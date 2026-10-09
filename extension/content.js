// Runs on the local foxbench server. When the popup started a task on this
// site, it shows the goal in a bar at the bottom of the page, with a link to
// the server's own verdict.
browser.storage.local.get(["active", "server", "key"]).then(({ active, server, key }) => {
  if (!(active && server && location.origin === new URL(server).origin && location.pathname.startsWith(`/${active.site}/`))) return;
  const bar = document.createElement("aside");
  bar.id = "foxbench-goal";
  bar.setAttribute("aria-label", "foxbench task");
  bar.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:2147483647;padding:10px 16px;background:#1d2330;color:#fff;font:14px/1.4 system-ui,sans-serif;display:flex;gap:16px;align-items:center";
  const goal = document.createElement("span");
  goal.className = "goal";
  goal.textContent = active.goal;
  const link = document.createElement("a");
  link.href = `/__fbn/result?key=${encodeURIComponent(key ?? "")}`;
  link.target = "_blank";
  link.textContent = "Check my result";
  link.style.color = "#9cc3ff";
  const label = document.createElement("strong");
  label.textContent = "Goal:";
  bar.append(label, goal, link);
  document.body.append(bar);
});
