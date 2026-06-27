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
- **ffmpeg** - general-purpose media inspection, transcoding, and streaming
  tooling, including RTP workflows that do not need camera hardware.
- **PulseAudio runtime audio capture helpers** - a per-container null sink for
  browsers, media players, and other app output, plus
  `codex-runtime-audio-rtp-stream`, which sends the sink monitor as Opus RTP
  with a lavfi fallback.
- Common CLI dependencies such as ripgrep and the firewall helper.

## Media and RTP utilities

`ffmpeg` is available in the base image even when no camera hardware is mapped
into the container. For example, external business logic can provide a media
file or network input and let the container send an RTP stream:

```shell
ffmpeg -re -i input.mp4 -an -c:v libx264 -preset ultrafast -tune zerolatency \
  -f rtp 'rtp://receiver:5004?pkt_size=1200'
```

Chromium is launched through `/opt/google/chrome/chrome`. The wrapper sources
`/home/node/browser-audio-setup.sh`, which is also available as
`/home/node/runtime-audio-setup.sh`. The setup starts a user PulseAudio daemon,
creates the `codex_runtime_sink` null sink, and sets it as the default runtime
audio output. The monitor source can be streamed as Opus RTP:

```shell
codex-runtime-audio-rtp-stream 'rtp://receiver:5006?pkt_size=1200'
```

Useful audio overrides:

```shell
# Default: try PulseAudio monitor capture, then fall back to lavfi silence.
CODEX_RUNTIME_AUDIO_CAPTURE=auto

# Force a lavfi test tone instead of captured runtime audio.
CODEX_RUNTIME_AUDIO_CAPTURE=lavfi \
CODEX_RUNTIME_AUDIO_SRC='sine=frequency=440:sample_rate=48000'

# Use a different PulseAudio sink/monitor name.
CODEX_RUNTIME_AUDIO_SINK=codex_runtime_sink
CODEX_RUNTIME_PULSE_MONITOR=codex_runtime_sink.monitor
```

The older `codex-browser-audio-*` command names and `CODEX_BROWSER_AUDIO_*`
variables are compatibility aliases. For a known media file, prefer direct
FFmpeg RTP from the file. Use the runtime PulseAudio sink when the goal is to
capture whatever an arbitrary app or browser is playing.

## Runtime app surface helper

When the gateway starts this image for an agent runtime app surface, it sets
`CODEX_APP_SURFACE_CONTAINER=1`. In that mode `codex-app-server-proxy` opens a
container-local Unix socket, `/tmp/codex-app-surface.sock` by default, and the
image provides `/home/node/app-surface-send.js` for sending app-surface
notifications to the gateway. The `codex-app-surface-send` symlink is also
available when PATH resolves it.

Examples from inside the running container:

```shell
/home/node/app-surface-send.js media side
/home/node/app-surface-send.js frame '{"type":"app.surface.html","title":"Clock","html":"<main>...</main>"}'
/home/node/app-surface-send.js html /tmp/clock.html --title Clock --css /tmp/clock.css --script /tmp/clock.js
/home/node/app-surface-send.js status "Clock running"
```

The proxy forwards only `app.surface.*` notifications through this local IPC
path. Override the socket path with `APP_SERVER_APP_SURFACE_IPC_SOCKET`; adjust
the maximum payload size with `APP_SERVER_APP_SURFACE_IPC_MAX_BYTES`.

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

1. Prepares Docker build artifacts under `codex-cli/dist/`.
2. Selects the release tag, `rust-v0.136.0` by default unless a tag is provided
   explicitly.
3. Downloads the Codex release npm tarballs for the current target triple.
   - The image creates a `codex-app-server` shim that runs
     `codex app-server` so the existing proxy contract is satisfied across
     release tags.
   - The image creates a `codex-linux-sandbox` shim that runs
     `codex linux-sandbox`.
4. Repackages the platform npm tarball under the local optional dependency name
   expected by the Codex launcher, for example `@openai/codex-linux-arm64`.
5. Feeds the Codex meta package and local platform package into the Docker
   build so the launcher can resolve its native optional dependency.
6. Runs `docker build` with the generated artifact to produce the final image.

## Playwright Browser Selection

The default build uses `PLAYWRIGHT_BROWSER_SOURCE=system`. This is the
recommended setting for Raspberry Pi hosts because it skips Playwright-managed
browser downloads during `docker build` and uses the Debian `chromium` package
installed in the image at `/opt/google/chrome/chrome`.

For the most reliable build, run:

```shell
cd ext/docker/pi
./build_image.sh
```

The generated Codex config points Playwright MCP at the system Chromium wrapper:

```toml
[mcp_servers.playwright]
command = "npx"
args = ["-y", "@playwright/mcp@latest", "--browser", "chromium", "--executable-path", "/opt/google/chrome/chrome"]
```

Useful overrides:

```shell
# Default and recommended for Pi: skip browser downloads, use Debian Chromium.
PLAYWRIGHT_BROWSER_SOURCE=system ./build_image.sh

# Try Playwright-managed Chromium first, then fall back to system Chromium.
PLAYWRIGHT_BROWSER_SOURCE=auto ./build_image.sh

# Require Playwright-managed Chromium; fail if it cannot be installed.
PLAYWRIGHT_BROWSER_SOURCE=playwright ./build_image.sh

# Timeout for the Playwright-managed browser install attempt when using
# PLAYWRIGHT_BROWSER_SOURCE=auto or playwright.
PLAYWRIGHT_BROWSER_SOURCE=auto PLAYWRIGHT_BROWSER_INSTALL_TIMEOUT_SEC=300 ./build_image.sh

# Use a different Chromium-compatible executable inside the image.
PLAYWRIGHT_MCP_EXECUTABLE_PATH=/path/to/chromium ./build_image.sh
```

Use `PLAYWRIGHT_BROWSER_SOURCE=auto` or `playwright` only when you specifically
need Playwright-managed browser binaries. Those modes depend on downloading
large browser artifacts during the Docker build and are more likely to fail on
slow or unreliable networks.

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
