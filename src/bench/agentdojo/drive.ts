// The cloud drive tools of AgentDojo's workspace suite (cloud_drive_client.py),
// on the environment JSON. Same ids, same checks, same error text.
import type { Form } from "./common.js";
import { addresses, nextId, refuse, some } from "./mailcal.js";

export interface DriveFile { id_: string; filename: string; content: string; owner: string; last_modified: string; shared_with: Record<string, "r" | "rw">; size: number }
export interface DriveEnv { cloud_drive: { account_email: string; initial_files: DriveFile[]; files: Record<string, DriveFile> } }

const fileOf = (e: DriveEnv, id: string) => e.cloud_drive.files[id] ?? refuse(`File with ID '${id}' not found.`);
const now = () => new Date().toISOString().slice(0, -1);
/** Python's len(): characters, not UTF-16 units. */
const size = (content: string) => [...content].length;

export const driveTools = {
  list_files: (e: DriveEnv) => Object.values(e.cloud_drive.files),
  get_file_by_id: (e: DriveEnv, { file_id = "" }: Form) => fileOf(e, file_id),
  search_files_by_filename: (e: DriveEnv, { filename = "" }: Form) => Object.values(e.cloud_drive.files).filter((f) => f.filename.toLowerCase().includes(filename.toLowerCase())),
  search_files: (e: DriveEnv, { query = "" }: Form) => some(Object.values(e.cloud_drive.files).filter((f) => f.content.toLowerCase().includes(query.toLowerCase())), `No files found with the given query ('${query}'). Try a different search term.`),
  create_file(e: DriveEnv, { filename = "", content = "" }: Form) {
    const file: DriveFile = { id_: nextId(e.cloud_drive.files), filename, content, owner: e.cloud_drive.account_email, last_modified: now(), shared_with: {}, size: size(content) };
    e.cloud_drive.files[file.id_] = file;
    return file;
  },
  delete_file(e: DriveEnv, { file_id = "" }: Form) {
    const file = fileOf(e, file_id);
    delete e.cloud_drive.files[file_id];
    return file;
  },
  append_to_file(e: DriveEnv, { file_id = "", content = "" }: Form) {
    const file = fileOf(e, file_id);
    file.content += content;
    [file.size, file.last_modified] = [size(file.content), now()];
    return file;
  },
  share_file(e: DriveEnv, { file_id = "", email = "", permission = "" }: Form) {
    const file = fileOf(e, file_id);
    if (permission !== "r" && permission !== "rw") refuse("Input should be 'r' or 'rw'");
    file.shared_with[addresses([email])[0]!] = permission as "r" | "rw";
    return file;
  },
};
