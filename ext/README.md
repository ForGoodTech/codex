# Codex Extensions

This directory contains helper assets for running Codex outside the main workspace. The current focus is on the Docker workflow that packages the standalone Codex binary, `codex-app-server`, and TCP proxies for both the app server and the Codex SDK into a single image.

## Docker image contents

The image built from `ext/docker/pi` includes:

- **Codex CLI** – the standalone codex binary staged under the npm installation so it is available on `PATH`.
- **codex-app-server** – the stdio app server packaged alongside the CLI.
- **codex-app-server-proxy** – a Node-based TCP bridge that spawns `codex-app-server` inside the container and exposes it over a single TCP port so you can forward it to the host.
- **codex-sdk-proxy** – a Node-based TCP bridge that uses the Codex TypeScript SDK (which shells out to the CLI) to run turns and stream JSONL events back to a single TCP client.
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
  -p 9400:9400 \
  -v "$PWD:/home/node/workdir" \
  my-codex-docker-image \
  bash

# Inside the container, launch the proxy (spawns codex-app-server on port 9395 by default)
codex-app-server-proxy

# Or start the SDK proxy (listens on port 9400 by default)
codex-sdk-proxy

# Or run Codex standalone inside the same container
codex "explain this repo"  # or any other prompt

```

Clients outside the container (for example, `ext/examples/hello-app-server.js`) default to the published host port (`127.0.0.1:9395`), so you can run them without extra environment variables:

```shell
node ext/examples/hello-app-server.js
```

For the SDK proxy, the sample scripts connect to `127.0.0.1:9400` by default:

```shell
node ext/examples/sdk-proxy-ping.js              # quick connectivity + run smoke test
node ext/examples/hello-sdk-proxy.js
node ext/examples/reasoning-sdk-proxy.js
node ext/examples/paste-image-sdk-proxy.js
node ext/examples/slash-commands-sdk-proxy.js    # interactive slash-command client
```

You can also ask the SDK proxy itself to run a one-off self-test prompt when it
starts (without any client) to confirm the Codex SDK path is working. The
self-test expects a usable `auth.json` inside the container (for example at
`/home/node/.codex/auth.json` or a path provided via `CODEX_AUTH_PATH`):

```shell
SDK_PROXY_SELF_TEST=1 codex-sdk-proxy   # or pass --self-test
```

When using the SDK proxy, the sample clients first try to read your local `~/.codex/auth.json` (override the path with
`CODEX_AUTH_PATH`) and send its contents to the proxy. If that file is absent, they fall back to forwarding host environment
variables such as `CODEX_API_KEY`, `OPENAI_API_KEY`, and optionally `OPENAI_BASE_URL`/`CODEX_BASE_URL` so the Codex CLI inside
the container can authenticate.

The proxy keeps the app server alive between client connections so you can reconnect without rebuilding state. The container remains available for direct Codex CLI use (`codex --help`, `codex "<prompt>"`, or `codex resume <session-id>`), and you can pass extra flags to the app server via `APP_SERVER_ARGS` when launching the proxy if you need custom behavior.

## Other assets

- `app-server-protocol-export/` – Generated TypeScript bindings and JSON Schemas for the Codex app-server protocol.
- `examples/` – Standalone scripts that demonstrate talking to the app server and the SDK proxy; point them at the proxy host/port described above.
