# Codex Extensions

This directory contains helper assets for running Codex outside the main workspace. The current focus is on the Docker workflow that packages the standalone Codex binary, `codex-app-server`, and a TCP proxy for the app server into a single image.

## Docker image contents

The image built from `ext/docker/pi` includes:

- **Codex CLI** – the standalone codex binary staged under the npm installation so it is available on `PATH`.
- **codex-app-server** – the stdio app server packaged alongside the CLI.
- **codex-app-server-proxy** – a Node-based TCP bridge that spawns `codex-app-server` inside the container and exposes it over a single TCP port so you can forward it to the host.
- **codex-sdk-proxy** – a Node-based TCP bridge that spawns `codex exec --experimental-json` inside the container and streams its stdout/stderr/exit events over TCP so SDK-style clients outside the container can talk to Codex without running inside the container.
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

Assume you want the proxies ready; publishing their ports is safe even if you only use the CLI. Bind-mount a workspace so Codex can access your files and give the container an explicit name.

```shell
docker run -it --rm \
  --name my-codex-docker-container \
  -p 9395:9395 \
  -p 9396:9396 \
  -v "$PWD:/home/node/workdir" \
  my-codex-docker-image \
  bash

# Inside the container, launch the proxies (port defaults shown)
codex-app-server-proxy  # app server over TCP on 9395
codex-sdk-proxy        # codex exec --experimental-json over TCP on 9396

# Or run Codex standalone inside the same container
codex "explain this repo"  # or any other prompt

```

Clients outside the container default to the published host ports (`127.0.0.1:9395` for the app server and `127.0.0.1:9396` for the SDK proxy), so you can run them without extra environment variables:

```shell
node ext/examples/hello-app-server.js
node ext/examples/sdk-proxy-client.js "Describe the repository."
```

All interactive examples now accept `USE_SDK_PROXY=1` (or `SDK_PROXY_TCP_HOST` / `SDK_PROXY_TCP_PORT`) to talk to the SDK proxy instead of the app server, while keeping their app-server behavior unchanged:

```shell
# Talk to the sdk-proxy from the host using the same interactive examples
USE_SDK_PROXY=1 node ext/examples/reasoning-client.js
USE_SDK_PROXY=1 node ext/examples/paste-image-client.js
USE_SDK_PROXY=1 node ext/examples/slash-commands.js
```

Each proxy keeps its underlying process alive between client connections so you can reconnect without rebuilding state. The container remains available for direct Codex CLI use (`codex --help`, `codex "<prompt>"`, or `codex resume <session-id>`), and you can pass extra flags to the app server via `APP_SERVER_ARGS` or to the CLI bridge via `SDK_PROXY_ARGS` when launching the proxies if you need custom behavior.

## Other assets

- `app-server-protocol-export/` – Generated TypeScript bindings and JSON Schemas for the Codex app-server protocol.
- `examples/` – Standalone scripts that demonstrate talking to the app server or SDK proxy; point them at the proxy host/port described above.
