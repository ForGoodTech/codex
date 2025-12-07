# Codex Extensions

This directory contains helper assets for running Codex outside the main workspace. The current focus is on the Docker workflow that packages the standalone Codex binary, `codex-app-server`, and a TCP proxy for the app server into a single image.

## Docker image contents

The image built from `ext/docker/pi` includes:

- **Codex CLI** – the standalone codex binary staged under the npm installation so it is available on `PATH`.
- **codex-app-server** – the stdio app server packaged alongside the CLI.
- **codex-app-server-proxy** – a Node-based TCP bridge that spawns `codex-app-server` inside the container and exposes it over a single TCP port so you can forward it to the host.
- Common CLI dependencies (ripgrep, firewall helper, etc.) preinstalled for convenience.

## Building Docker images

A helper script builds the npm package, stages native binaries, and produces the Docker image without relying on a published registry artifact. It supports both debug and release builds of the Rust components.

```shell
cd ext/docker/pi
# Build a debug image tagged "my-codex-docker-image" (default)
./build_image.sh

# Build a debug image with a custom tag
CODEX_IMAGE_TAG=codex-dev ./build_image.sh

# Build a release image with a custom tag
CODEX_IMAGE_TAG=codex-release ./build_image.sh codex-release release
```

What the script does:

1. Installs JavaScript dependencies for the CLI with `pnpm install`.
2. Builds the native `codex` and `codex-app-server` binaries from the workspace if they are not already present, honoring the requested profile (`debug` or `release`).
3. Gathers the binaries (and `rg`) under `codex-cli/vendor/<target-triple>/` so the npm package can ship them.
4. Packs the CLI (`pnpm pack`) into `dist/codex.tgz` and feeds it into the Docker build.
5. Runs `docker build` with the generated artifact to produce the final image.

Debug builds reuse `target/debug` artifacts; release builds pull from `target/release`. Set `CODEX_IMAGE_TAG` or pass an image tag as the first argument to name the resulting image.

## Running Codex in a container

Start an interactive container when you want to use the Codex CLI directly. Bind-mount a workspace so Codex can access your files.

```shell
docker run -it --rm \
  -v "$PWD:/home/node/workdir" \
  my-codex-docker-image \
  bash

# Inside the container
codex --help
codex run <path-to-your-session>
```

The image defaults to `/home/node/workdir` as the working directory and enables an unsafe sandbox mode suitable for containerized use. Adjust mounts and environment variables as needed for your project.

## Exposing the app server via TCP

Use the bundled proxy to run `codex-app-server` inside the container while exposing it to the host through a single TCP port (useful when the host cannot easily create FIFOs).

```shell
# Start the container and publish the proxy port (default 9395) to the host
docker run -it --rm -p 9395:9395 my-codex-docker-image bash

# Inside the container, launch the proxy (spawns codex-app-server)
codex-app-server-proxy

# Optional environment overrides
# APP_SERVER_PORT=9400 APP_SERVER_CMD=codex-app-server APP_SERVER_ARGS="--help" codex-app-server-proxy
```

Clients outside the container (for example, `ext/examples/hello-app-server.js`) can connect using the published host port (`APP_SERVER_TCP_HOST=127.0.0.1`, `APP_SERVER_TCP_PORT=9395`). The proxy keeps the app server alive between client connections so you can reconnect without rebuilding state.

## Other assets

- `app-server-protocol-export/` – Generated TypeScript bindings and JSON Schemas for the Codex app-server protocol.
- `examples/` – Standalone scripts that demonstrate talking to the app server; point them at the proxy host/port described above.
