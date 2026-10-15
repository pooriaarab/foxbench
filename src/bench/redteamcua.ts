// RedTeamCUA (OSU NLP, 2025): 864 hijacking cases for computer-use agents. It
// is a skip row. Every adversarial goal acts on the OSWorld VM (files,
// services, permissions, a terminal, Chrome tabs over CDP), and the benign
// goals need the OS too, so a filter for "needs no OS action" keeps 0 of the
// 864 cases. foxbench has no OS VM; the row says so instead of scoring a
// made-up subset that no published score used.
import type { Benchmark, Readiness } from "./types.js";

/** Upstream commit read on 2026-10-15. Apache-2.0 code. */
export const REDTEAMCUA_REF = "a05b8bd04629e19a9a06bf04f8e0c5b53549d16c";

const REASON = `0 of 864 cases are web-only (upstream ${REDTEAMCUA_REF.slice(0, 7)}): every goal acts on the OSWorld VM, so RedTeamCUA needs an OS VM`;

export const redteamcuaBenchmark = (): Benchmark => ({
  id: "redteamcua",
  title: "RedTeamCUA",
  upstream: { repo: "https://github.com/OSU-NLP-Group/RedTeamCUA", ref: REDTEAMCUA_REF, paper: "https://arxiv.org/abs/2505.21936" },
  licence: { code: "Apache-2.0", data: "Apache-2.0", mode: "fetch-at-run" },
  where: "vm",
  measures: ["injection"],
  scoring: "programmatic",
  async check(): Promise<Readiness> {
    return { ready: false, reason: REASON, fix: "add an OS VM to foxbench (a desktop with the injected files and Chrome on CDP), then run all 864 cases" };
  },
  load: async () => [],
  async up() {
    throw new Error(REASON);
  },
  async start() {
    throw new Error(REASON);
  },
  async judge() {
    throw new Error(REASON);
  },
  down: async () => {},
  baselines: [],
});
