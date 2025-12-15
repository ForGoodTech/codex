# Codex Extensions

This directory contains helper assets for running Codex outside the main workspace. The current focus is on the Docker workflow that packages the standalone Codex binary, `codex-app-server`, and a TCP proxy for the app server into a single image.

## Docker image contents

The image built from `ext/docker/pi` includes:

- **Codex CLI** – the standalone codex binary staged under the npm installation so it is available on `PATH`.
- **codex-app-server** – the stdio app server packaged alongside the CLI.
- **codex-app-server-proxy** – a Node-based TCP bridge that spawns `codex-app-server` inside the container and exposes it over a single TCP port so you can forward it to the host.
- **codex-sdk-proxy** – a Node-based TCP bridge, patterned after the app-server proxy, that exposes a single TCP port for SDK clients outside the container. It uses the Codex TypeScript SDK inside the container to talk to the Codex core and streams turn events back to the client over JSONL.
- Common CLI dependencies (ripgrep, firewall helper, etc.) preinstalled for convenience.

## Building Docker images

A helper script builds the npm package, stages native binaries, and produces the Docker image without relying on a published registry artifact. It supports both debug and release builds of the Rust components.

```shell
cd ext/docker/pi
# Build a debug image tagged "my-codex-docker-image" (default)
./build_image.sh

# Build a debug image with a custom tag
./build_image.sh codex-dev

# Build a release image with a custom tag
./build_image.sh codex-release release
```

The optional arguments are positional: the first sets the image tag; the second chooses the Rust profile (`debug` by default, `release` when specified). What the script does:

1. Installs JavaScript dependencies for the CLI with `pnpm install`.
2. Builds the native `codex` and `codex-app-server` binaries from the workspace if they are not already present, honoring the requested profile (`debug` or `release`).
3. Gathers the binaries (and `rg`) under `codex-cli/vendor/<target-triple>/` so the npm package can ship them.
4. Packs the CLI (`pnpm pack`) into `dist/codex.tgz` and feeds it into the Docker build.
5. Runs `docker build` with the generated artifact to produce the final image.

Debug builds reuse `target/debug` artifacts; release builds pull from `target/release`. Pass an image tag as the first argument to name the resulting image (defaults to `my-codex-docker-image`).

## Running Codex and the app server in a container

> **Reminder:** Follow the official OpenAI Codex login process for headless console access to generate your `auth.json` (by default saved as `~/.codex/auth.json`). After obtaining it, copy the file into the container's `.codex` directory, for example with `docker cp ~/.codex/auth.json my-codex-docker-container:/home/node/.codex/auth.json` (adjust the container name if you used a different one).

Assume you want the app server ready; publishing the proxy port is safe even if you only use the CLI. Bind-mount a workspace so Codex can access your files and give the container an explicit name.

```shell
docker run -it --rm \
  --name my-codex-docker-container \
  -p 9395:9395 \
  -v "$PWD:/home/node/workdir" \
  my-codex-docker-image \
  bash

# Inside the container, launch the proxy (spawns codex-app-server on port 9395 by default)
codex-app-server-proxy

# Or run Codex standalone inside the same container
codex "explain this repo"  # or any other prompt

```

Clients outside the container (for example, `ext/examples/hello-app-server.js`) default to the published host port (`127.0.0.1:9395`), so you can run them without extra environment variables:

```shell
node ext/examples/hello-app-server.js
```

The proxy keeps the app server alive between client connections so you can reconnect without rebuilding state. The container remains available for direct Codex CLI use (`codex --help`, `codex "<prompt>"`, or `codex resume <session-id>`), and you can pass extra flags to the app server via `APP_SERVER_ARGS` when launching the proxy if you need custom behavior.

## Running the TypeScript SDK outside the container

The Docker image also bundles `codex-sdk-proxy`, which lets the official TypeScript SDK run on the host while the Codex core stays inside the container. The proxy handles one client connection at a time (mirroring the app server proxy) and relays streamed Codex events over a TCP socket.

1. Start the proxy inside the container (publish a port such as 9400 when running `docker run`):

   ```shell
   codex-sdk-proxy
   ```

2. On the host, use the provided sample clients to talk to the proxy over TCP without changing any SDK code:

   ```shell
   # From the repo root, with the container port forwarded to the host
   node ext/examples/hello-sdk-proxy.js "explain this repo"

   # Keep a running thread alive while you iterate on prompts
   node ext/examples/reasoning-sdk-proxy.js

   # Send local images alongside a text prompt
   node ext/examples/paste-image-sdk-proxy.js
   ```

   You can override the proxy location with `CODEX_SDK_PROXY_HOST`/`CODEX_SDK_PROXY_PORT` if you are not using the defaults (127.0.0.1:9400). The script accepts the usual Codex environment variables (`CODEX_API_KEY`, `OPENAI_BASE_URL`, `CODEX_MODEL`, etc.) and forwards them to the proxy.

The SDK proxy streams JSONL messages back to the client exactly as it would from a local Codex binary, so external callers can live outside the container while keeping all Codex execution inside it.

## Other assets

- `app-server-protocol-export/` – Generated TypeScript bindings and JSON Schemas for the Codex app-server protocol.
- `examples/` – Standalone scripts that demonstrate talking to the app server; point them at the proxy host/port described above.
