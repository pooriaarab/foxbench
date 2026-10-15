// Tests that need fixed ports (a site's port moved by an offset, or Episode.port)
// pick the base at run time. A fixed one can sit inside the OS ephemeral range
// (Linux 32768-60999), where a listen(0) server or an outgoing connection in a
// parallel test file holds it at random. Each file gets its own band, below that
// range, so two files never probe the same ports; the probe finds the ports
// something else on the machine holds.
import { createServer } from "node:net";

const canBind = (port: number, host: string) => new Promise<boolean>((resolve) => {
  const server = createServer();
  server.once("error", () => resolve(false));
  server.listen(port, host, () => server.close(() => resolve(true)));
});

/** A base in [lo, lo + span) where base + each of `ports` is free on every host. */
export async function freeBase(lo: number, span: number, ports: number[], hosts = ["127.0.0.1"]): Promise<number> {
  const start = Math.floor(Math.random() * span);
  for (let i = 0; i < span; i++) {
    const base = lo + ((start + i) % span);
    const free = await Promise.all(ports.flatMap((p) => hosts.map((h) => canBind(base + p, h))));
    if (free.every(Boolean)) return base;
  }
  throw new Error(`no base in ${lo}-${lo + span - 1} has ports ${ports.join(", ")} free on ${hosts.join(", ")}`);
}
