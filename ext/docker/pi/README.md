# Codex Docker Image for Pi

This directory builds a Docker image that packages the standalone Codex binary,
`codex-app-server`, and TCP proxies for both the app server and the Codex SDK
into a single image.

## Image contents

The image built from `ext/docker/pi` includes:

- **Codex CLI** - the standalone `codex` binary staged under the npm
  installation so it is available on `PATH`.
- **codex-app-server** - a shim that runs the stdio app server through the
  packaged CLI.
- **codex-app-server-proxy** - a Node-based TCP bridge that spawns
  `codex-app-server` inside the container and exposes it over a single TCP port
  so you can forward it to the host.
- **codex-sdk-proxy** - a Node-based TCP bridge that uses the Codex TypeScript
  SDK, which shells out to the CLI, to run turns and stream JSONL events back to
  a single TCP client.
- Common CLI dependencies such as ripgrep and the firewall helper.

## Building the image

The helper script builds the npm package, stages native binaries, and produces
the Docker image. The Codex release binary is downloaded from an upstream
GitHub release tag, `rust-v0.136.0` by default, or an explicitly provided tag.

```shell
cd ext/docker/pi

# Build an image tagged "my-codex-docker-image" using rust-v0.136.0.
./build_image.sh

# Build with a custom image tag.
./build_image.sh codex-dev

# Build with a custom image tag and an explicit Codex release tag.
./build_image.sh codex-release rust-v0.136.0
```

The optional arguments are positional: the first sets the image tag; the second
sets the upstream Codex release tag. You can also set `CODEX_RELEASE_TAG` in the
environment. If no tag is provided, the script uses `rust-v0.136.0`.

What the script does:

1. Installs JavaScript dependencies for the CLI with `pnpm install`.
2. Selects the release tag, `rust-v0.136.0` by default unless a tag is provided
   explicitly.
3. Downloads the `codex` release tarball for the current target triple.
   - The script always creates a `codex-app-server` shim that runs
     `codex app-server` so the existing proxy contract is satisfied across
     release tags.
   - The script creates a `codex-linux-sandbox` shim that runs
     `codex linux-sandbox`.
4. Gathers the binaries and `rg` under `codex-cli/vendor/<target-triple>/` so
   the npm package can ship them.
5. Packs the CLI with `pnpm pack` into `dist/codex.tgz` and feeds it into the
   Docker build.
6. Runs `docker build` with the generated artifact to produce the final image.

## Playwright browser selection

By default the build uses `PLAYWRIGHT_BROWSER_SOURCE=auto`: it tries to install
Playwright-managed Chromium first, with a bounded timeout, then falls back to the
Debian `chromium` package at `/opt/google/chrome/chrome` if the Playwright
download fails or times out. When fallback happens, the builder prints a warning
and a `docker run ... install-browser ...` command you can use to check whether
Playwright browser downloads are working again.

Useful overrides:

```shell
# Default: try Playwright-managed Chromium, fall back to system Chromium.
PLAYWRIGHT_BROWSER_SOURCE=auto

# Require Playwright-managed Chromium; fail the build if it cannot be installed.
PLAYWRIGHT_BROWSER_SOURCE=playwright

# Skip Playwright browser downloads and always use Debian Chromium.
PLAYWRIGHT_BROWSER_SOURCE=system

# Default timeout for the Playwright browser install attempt.
PLAYWRIGHT_BROWSER_INSTALL_TIMEOUT_SEC=1800
```

Override `PLAYWRIGHT_MCP_EXECUTABLE_PATH` if you provide a different
Chromium-compatible system executable.

## MCP startup timeout tuning

The generated image sets a default Playwright MCP startup timeout in
`/home/node/.codex/config.toml`:

```toml
[mcp_servers.playwright]
startup_timeout_sec = 30
```

If you see startup warnings on slower hosts, set
`PLAYWRIGHT_MCP_STARTUP_TIMEOUT_SEC` when building to increase the value:

```shell
cd ext/docker/pi
PLAYWRIGHT_MCP_STARTUP_TIMEOUT_SEC=60 ./build_image.sh codex-dev
```

Pick any integer number of seconds that matches your environment. You can also
edit `/home/node/.codex/config.toml` in an existing container and change
`startup_timeout_sec` directly.

## Running Codex and the app server

Follow the official OpenAI Codex login process for headless console access to
generate your `auth.json`, by default saved as `~/.codex/auth.json`. For the
app-server proxy flow, keep this file on the client side, either on the host or
in an examples container, so auth is delivered on demand. The proxy container
does not need `auth.json` at rest.

### App server proxy token

`codex-app-server-proxy` requires an authentication handshake token. The proxy
reads it from `APP_SERVER_PROXY_TOKEN`, and app-server clients must send this
first JSONL frame right after TCP connect:

```json
{"type":"auth","token":"<APP_SERVER_PROXY_TOKEN>"}
```

Use the helper script in `ext/examples/app-server-auth.js` to derive this value
from `auth.json`, then pass it to the proxy container. App-server clients must
send the same token in their first auth frame.

The app-server examples do not copy `auth.json` into the proxy container.
Instead, they read auth on the client side and forward runtime auth material to
app-server via `account/login/start` with `type: "chatgptAuthTokens"`.

You can also run the helper standalone to print the token for quick verification
or testing:

```shell
node ext/examples/app-server-auth.js --print-proxy-token
```

Create a shared Docker network so the proxy and any client containers can talk
without publishing ports on the host. Bind-mount a workspace so Codex can access
your files and give the container an explicit name. These commands assume you
are running from the repository root.

This image runs as `node` by default.

```shell
docker network create codex-net

# Derive the required proxy token from auth.json on the host.
APP_SERVER_PROXY_TOKEN="$(node ext/examples/app-server-auth.js --print-proxy-token)"

docker run -it --rm \
  --name codex-proxy \
  --network codex-net \
  -e APP_SERVER_PROXY_TOKEN="$APP_SERVER_PROXY_TOKEN" \
  -v "$PWD:/home/node/workdir" \
  my-codex-docker-image \
  bash

# Inside the container, launch the proxy.
codex-app-server-proxy

# Or start the SDK proxy.
codex-sdk-proxy

# Or run Codex standalone inside the same container.
codex "explain this repo"
```

If you want a detached proxy container, pass the proxy command directly:

```shell
docker run -d \
  --name codex-proxy \
  --network codex-net \
  -e APP_SERVER_PROXY_TOKEN="$APP_SERVER_PROXY_TOKEN" \
  -v "$PWD:/home/node/workdir" \
  my-codex-docker-image \
  codex-app-server-proxy
```

## Building and running the examples image

The sample clients default to `codex-proxy` for the proxy host, so run them in a
second container on the same network.

For app-server examples such as `hello-app-server.js`, `reasoning-client.js`,
`resume-client.js`, `paste-image-client.js`, and `slash-commands.js`:

- The scripts send the required proxy auth frame automatically.
- They also read `auth.json` directly, via `CODEX_AUTH_PATH` or
  `~/.codex/auth.json`, and forward ChatGPT auth token info to app-server using
  `account/login/start` with `type: "chatgptAuthTokens"`.

When running the examples container, mount the same `auth.json` so the scripts
can derive the handshake token and forward auth to app-server.

```shell
cd ext/examples

# Build a Node image with the sample scripts.
./build_image.sh codex-examples

# Run any example on the shared network.
docker run --rm \
  --network codex-net \
  -v "$HOME/.codex/auth.json:/home/node/.codex/auth.json:ro" \
  codex-examples node /examples/hello-app-server.js

docker run --rm --network codex-net codex-examples node /examples/sdk-proxy-ping.js
```

If you prefer to run the scripts on the host instead of in a container, publish
the proxy ports and override the host defaults, for example
`APP_SERVER_TCP_HOST=127.0.0.1` or `SDK_PROXY_HOST=127.0.0.1`.

You can ask the SDK proxy itself to run a one-off self-test prompt when it starts
without any client, to confirm the Codex SDK path is working. The self-test
expects a usable `auth.json` inside the container, for example at
`/home/node/.codex/auth.json` or a path provided via `CODEX_AUTH_PATH`:

```shell
SDK_PROXY_SELF_TEST=1 codex-sdk-proxy
```

When using the SDK proxy, the sample clients first try to read your local
`~/.codex/auth.json`, or the path specified by `CODEX_AUTH_PATH`, and send its
contents to the proxy. If that file is absent, they fall back to forwarding host
environment variables such as `CODEX_API_KEY`, `OPENAI_API_KEY`, and optionally
`OPENAI_BASE_URL` or `CODEX_BASE_URL` so the Codex CLI inside the container can
authenticate.

The proxy keeps the app server alive between client connections so you can
reconnect without rebuilding state. The container remains available for direct
Codex CLI use with `codex --help`, `codex "<prompt>"`, or
`codex resume <session-id>`. By default the proxy starts `codex-app-server` with
no extra sandbox overrides; if you need custom startup flags, set
`APP_SERVER_ARGS`. To point the app server at a specific `codex-linux-sandbox`
binary inside the container, set `APP_SERVER_CODEX_LINUX_SANDBOX_EXE` or
`CODEX_LINUX_SANDBOX_EXE`; the proxy defaults to
`/usr/local/share/npm-global/bin/codex-linux-sandbox`.
