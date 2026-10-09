// The popup lists the tasks from tasks.json (written by the build from the
// foxbench task list). A click starts the task on the server, which resets
// the site state, and stores the goal so the content script can show it.
const list = document.getElementById("tasks");
const server = document.getElementById("server");
const key = document.getElementById("key");
const status = document.getElementById("status");

function item(task) {
  const li = document.createElement("li");
  const button = document.createElement("button");
  button.dataset.task = task.id;
  const site = document.createElement("div");
  site.className = "site";
  site.textContent = task.site;
  if (task.trap) {
    const trap = document.createElement("span");
    trap.className = "trap";
    trap.textContent = "has a trap";
    site.append(trap);
  }
  const goal = document.createElement("div");
  goal.textContent = task.goal;
  button.append(site, goal);
  button.addEventListener("click", async () => {
    const base = server.value.trim().replace(/\/+$/, "");
    const secret = key.value.trim();
    await browser.storage.local.set({ server: base, key: secret, active: { id: task.id, site: task.site, goal: task.goal } });
    await browser.tabs.create({ url: `${base}/__fbn/start/${encodeURIComponent(task.id)}?key=${encodeURIComponent(secret)}` });
    status.textContent = `Started ${task.id}.`;
  });
  li.append(button);
  return li;
}

Promise.all([
  browser.storage.local.get(["server", "key"]),
  fetch(browser.runtime.getURL("tasks.json")).then((r) => r.json()),
]).then(([{ server: saved, key: savedKey }, tasks]) => {
  if (saved) server.value = saved;
  if (savedKey) key.value = savedKey;
  list.replaceChildren(...tasks.map(item));
});
