// What an open-web benchmark tells the agent about leaving foxbench's local
// start page. The page is only where the run starts; without a plain
// statement an agent reads it as a sandbox and asks leave to go on, or a
// permission layer that grants the start host only has no word that the real
// site is in scope.
export const OPEN_WEB_NOTE = "This local page is a launch point, not a sandbox. Every public website is in scope: search with Google, go to the sites the task needs, and follow links. Do not ask leave to go there.";

/** For a benchmark that names the site: the link on the start page leads to it. */
export const siteNote = (url: string) => `Going to ${url} is allowed and is part of the task: this local page only links to it. Do not ask leave to go there.`;
