/**
 * The startup script's Docker setup: Google's Docker Hub mirror goes into daemon.json before Docker's first pull, so a VM behind a shared
 * Cloud NAT IP is not held to Docker Hub's anonymous limit for what the mirror has. Docker falls back to Hub for a layer the mirror lacks.
 * Docker restarts only when the file changed.
 */
export function dockerMirror(): string {
  return `J=\${DOCKER_DAEMON_JSON:-/etc/docker/daemon.json}
mkdir -p "$(dirname "$J")"
printf '{\\n  "registry-mirrors": ["https://mirror.gcr.io"]\\n}\\n' > "$J.new"
if cmp -s "$J.new" "$J"; then rm "$J.new"; changed=0; else mv "$J.new" "$J"; changed=1; fi
systemctl enable --now docker
[ $changed -eq 0 ] || systemctl restart docker`;
}
