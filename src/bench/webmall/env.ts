// WebMall (University of Mannheim): 4 WooCommerce shops, Elasticsearch and a
// start page, as one Docker Compose project. The upstream repo has no licence,
// so nothing of it is committed: `webmallScript` fetches its compose file at a
// pinned commit and its data backups from the authors' server, then runs them
// with our own override (pinned images, our own volume names, the proxy's URLs).
// The same script is the VM's startup script and the local-Docker mode.

export const WEBMALL_REPO = "wbsg-uni-mannheim/WebMall";
/** The commit of 2026-08-03. */
export const WEBMALL_REF = "2697d35cdfcfedcf1ade89b7ad86722db8daa8a7";
export const WEBMALL_BACKUPS = "https://data.dws.informatik.uni-mannheim.de/webmall/backup";
export const WEBMALL_PROJECT = "foxbench-webmall";
export const TUNNEL_OFFSET = 10000;

/** The images of the compose file, pinned by the digest they had when the backups were checked to load. */
export const WEBMALL_IMAGES = {
  elasticsearch: "docker.elastic.co/elasticsearch/elasticsearch@sha256:d118fc05cfa714a4577731384ec8b08fe7e70c203a6949b0581e0f6ebe54b0af",
  mariadb: "bitnami/mariadb@sha256:354e5aec20455bce931a05fa791c51e4a45879015bee09591295c76fe88c037e",
  wordpress: "bitnami/wordpress@sha256:845d250ecd73f5e9b8ab2c42ab8b32407992456bab4dcb79547f2c0b7d25959b",
  nginx: "nginx@sha256:eadee7f433e6757b5148fabac9c7a1cc51b5248ca8b9b8ab27697cb3dd274f4b",
  busybox: "busybox@sha256:fd7dc98638c8e305f4dc34e979f1c0fdfdcaeb0fbf8fcff77ae834b6da3d7e6e",
};

export interface WebmallSite {
  id: "shop1" | "shop2" | "shop3" | "shop4" | "frontend";
  /** The port the agent sees (the proxy's). The site's own URL is on it, as upstream's `SHOPn_URL`. */
  port: number;
  /** The shop's name in the task texts, and the host its data was made for. */
  name: string;
}

// Ports as upstream's docker_all/.env.example; shop names as its task.py.
export const webmallSites: WebmallSite[] = [
  { id: "shop1", port: 8081, name: "E-Store Athletes" },
  { id: "shop2", port: 8082, name: "TechTalk" },
  { id: "shop3", port: 8083, name: "CamelCases" },
  { id: "shop4", port: 8084, name: "Hardware Cafe" },
  { id: "frontend", port: 8085, name: "start page" },
];

const shops = webmallSites.filter((s) => s.id !== "frontend");

/**
 * The script that brings WebMall up and is safe to run again. `bind` is the
 * address the sites listen on at their port + TUNNEL_OFFSET: 0.0.0.0 on a VM
 * (the IAP tunnel reaches its internal address), 127.0.0.1 on a local host.
 */
export function webmallScript(opts: { bind: string; dir: string }): string {
  const { bind, dir } = opts;
  const i = WEBMALL_IMAGES;
  const backups = shops.flatMap((s, n) => [`mariadb_data_shop${n + 1}`, `wordpress_data_shop${n + 1}`]);
  const ports = webmallSites.map((s, n) => `${s.id === "frontend" ? "FRONTEND" : `SHOP${n + 1}`}_PORT=${bind}:${s.port + TUNNEL_OFFSET}`);
  const services = [["elasticsearch", i.elasticsearch], ...shops.flatMap((_, n) => [[`mariadb_shop${n + 1}`, i.mariadb], [`wordpress_shop${n + 1}`, i.wordpress]]), ["webmall_frontend", i.nginx]];
  const override = ["services:", ...services.map(([s, image]) => `  ${s}:\n    image: ${image}${s === "elasticsearch" ? "\n    ports: !reset []\n    environment:\n      - ES_JAVA_OPTS=-Xms512m -Xmx512m $ARM_JAVA\n      - CLI_JAVA_OPTS=$ARM_JAVA" : ""}`), "volumes:",
    "  esdata:\n    name: foxbench_webmall_es",
    ...shops.flatMap((_, n) => [`  woocommerce_mariadb_data_shop${n + 1}:\n    name: foxbench_webmall_mariadb_shop${n + 1}`, `  woocommerce_wordpress_data_shop${n + 1}:\n    name: foxbench_webmall_wordpress_shop${n + 1}`])];
  return `#!/bin/sh
# webmall: fetch, restore and start the WebMall sites. Runs again without redoing a finished setup.
set -e
D=${dir}
P=${WEBMALL_PROJECT}
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
docker compose version >/dev/null
mkdir -p "$D/backup"
cd "$D"
if [ ! -f src/docker_all/docker-compose.yml ]; then
  rm -rf src && mkdir src
  curl -fsSL https://codeload.github.com/${WEBMALL_REPO}/tar.gz/${WEBMALL_REF} | tar xz -C src --strip-components=1
fi
cat > webmall.env <<'ENV'
${ports.join("\n")}
ENV
# Upstream's compose file sets -XX:UseSVE=0 for ARM; an x86 JVM does not know it.
case "$(uname -m)" in arm64|aarch64) ARM_JAVA=-XX:UseSVE=0 ;; *) ARM_JAVA= ;; esac
cat > override.yml <<YML
${override.join("\n")}
YML
dc() { docker compose -p $P --env-file webmall.env -f src/docker_all/docker-compose.yml -f override.yml "$@"; }
if [ ! -f ready ]; then
  for f in ${backups.join(" ")}; do
    [ -f backup/$f.tar.gz ] && continue
    curl -fL --retry 20 --retry-delay 10 -o backup/$f.part ${WEBMALL_BACKUPS}/$f.tar.gz && gzip -t backup/$f.part && mv backup/$f.part backup/$f.tar.gz || { rm -f backup/$f.part; echo "could not fetch $f" >&2; exit 1; }
  done
  dc down -v
  for n in 1 2 3 4; do
    docker run --rm -v foxbench_webmall_mariadb_shop$n:/volume -v "$D/backup":/backup ${i.busybox} tar xzf /backup/mariadb_data_shop$n.tar.gz -C /volume
    docker run --rm -v foxbench_webmall_wordpress_shop$n:/volume -v "$D/backup":/backup ${i.busybox} tar xzf /backup/wordpress_data_shop$n.tar.gz -C /volume
    sed "s#http://localhost:SHOP\${n}_PORT_PLACEHOLDER#http://127.0.0.1:$((8080 + n))#g" src/docker_all/deployed_wp_config_local/shop_$n.php > wp-config.$n.php
    docker run --rm -v foxbench_webmall_wordpress_shop$n:/volume -v "$D":/src ${i.busybox} cp /src/wp-config.$n.php /volume/wp-config.php
  done
  dc up -d
  for n in 1 2 3 4; do
    until docker exec WebMall_wordpress_shop$n wp core is-installed --path=/opt/bitnami/wordpress 2>/dev/null; do sleep 5; done
    # The backup also holds http://localhost:808n:808n (upstream's own restore script doubles the port).
    for from in "https://webmall-$n.informatik.uni-mannheim.de" "http://localhost:808$n:808$n" "http://localhost:808$n"; do
      docker exec WebMall_wordpress_shop$n wp search-replace "$from" "http://127.0.0.1:$((8080 + n))" --all-tables --path=/opt/bitnami/wordpress
    done
    docker exec WebMall_wordpress_shop$n wp cache flush --path=/opt/bitnami/wordpress
  done
  touch ready
else
  dc up -d
fi
for port in ${webmallSites.map((s) => s.port).join(" ")}; do
  tries=0
  until curl -fs -o /dev/null -H "Host: 127.0.0.1:$port" http://127.0.0.1:$((port + ${TUNNEL_OFFSET})); do
    tries=$((tries + 1))
    [ $tries -lt 120 ] || { echo "port $port did not answer" >&2; exit 1; }
    sleep 5
  done
done
echo "webmall is up"
`;
}

/** The VM's startup script: Docker, then the same script as local mode. */
export const webmallStartup = (): string => webmallScript({ bind: "0.0.0.0", dir: "/srv/foxbench/webmall" });
