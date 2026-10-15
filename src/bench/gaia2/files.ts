// The file pages, over ARE's Files app: a folder listing, a file with its
// contents, and forms to make a folder, move and delete.
import { done, esc, form, input, type Handler } from "./pages.js";

interface Entry { name: string; type: string; size: number }
const parent = (path: string) => path.replace(/\/[^/]*$/, "") || "/";

export const files: Handler = async (api, { path, query, form: posted }) => {
  if (posted) {
    if (path === "/files/mkdir") return done(await api.call("Files", "mkdir", { path: posted.get("path"), create_parents: posted.get("create_parents") }));
    if (path === "/files/mv") return done(await api.call("Files", "mv", { path1: posted.get("path1"), path2: posted.get("path2"), recursive: posted.get("recursive") }));
    if (path === "/files/rm") return done(await api.call("Files", "rm", { path: posted.get("path"), recursive: posted.get("recursive") }));
    return null;
  }
  const at = query.get("path") ?? "/";
  if (path === "/files/view") {
    const info: Entry = await api.call("Files", "info", { path: at });
    return { title: at, body: `<p>${esc(info.type)}, ${info.size} bytes. <a href="/files?path=${encodeURIComponent(parent(at))}">Up</a></p><pre>${esc(await api.call("Files", "cat", { path: at }))}</pre>` };
  }
  if (path !== "/files") return null;
  const entries: Entry[] = await api.call("Files", "ls", { path: at, detail: true });
  const rows = entries.map((e) => `<li><a href="/files${e.type === "directory" ? "" : "/view"}?path=${encodeURIComponent(e.name)}">${esc(e.name)}</a> (${esc(e.type)}, ${e.size} bytes)</li>`);
  return { title: `Files: ${at}`, body: `<p><a href="/files?path=${encodeURIComponent(parent(at))}">Up</a></p><ul>${rows.join("")}</ul>`
    + form("/files/mkdir", "Make a folder", input("path", "path", at + "/") + input("create_parents", "create_parents (true or false)")) + form("/files/mv", "Move", input("path1", "from") + input("path2", "to") + input("recursive", "recursive (true or false)"))
    + form("/files/rm", "Delete", input("path", "path") + input("recursive", "recursive (true or false)")) };
};
