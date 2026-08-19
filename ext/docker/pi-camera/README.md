# Codex Docker Image for Pi Camera

This directory is the camera/vision extension of `ext/docker/pi`. Its runtime
stage inherits the Pi base image, including the Codex CLI, app-server and SDK
proxies, managed `auth.json` broker, MCP configuration, and
Playwright/Chrome tooling, then adds Raspberry Pi camera, OpenCV, and NCNN
support for agentic vision work inside Docker.

## What gets added

- `v4l-utils` from Debian. The base Pi image already includes `ffmpeg` for
  media and RTP workflows.
- OpenCV and NumPy Python bindings from Debian for frame decoding, transforms,
  feature extraction, and other computer vision tasks.
- A pinned NCNN release built with its Python API, shared C++ library, headers,
  and model optimization tools. CPU inference is enabled by default.
- `rpicam-apps-core`, `rpicam-apps-encoder`, and
  `rpicam-apps-opencv-postprocess` from the Raspberry Pi Bookworm apt archive on
  `arm64` and `armhf` builds.
- `/home/node/app-surface-send.js`, the same app-surface notification helper
  provided by the base Pi runtime image. The `codex-app-surface-send` symlink is
  also available when PATH resolves it.
- `codex-runtime-audio-rtp-stream`, the same runtime-audio Opus RTP helper
  provided by the base Pi runtime image.
- `codex-camera-smoke-test`, a container-side camera/device sanity check.
- `codex-vision-smoke-test`, a hardware-independent OpenCV-to-NCNN inference
  check.
- `codex-camera-rtp-stream`, a container-side RTP helper around
  `rpicam-vid | ffmpeg`. The same FFmpeg process atomically refreshes a latest
  JPEG so vision consumers do not need to compete for the camera device.
- `run_camera_container.sh`, a host-side launcher that maps selected camera
  devices without using `--privileged` by default.
- A root entrypoint that creates container-local device nodes for root-only
  host devices such as `/dev/dma_heap/*`, then drops to the `node` user before
  running Codex or the requested command.

The image is still a Docker container, not a VM. It relies on the host Raspberry
Pi kernel and drivers for the camera hardware, then grants the container access
to the relevant `/dev/*` nodes.

## Build

From the repository root:

```shell
cd ext/docker/pi-camera
./build_image.sh
```

The default image tag is `my-codex-pi-camera-image`. Override it with either a
positional argument or `CODEX_IMAGE_TAG`:

```shell
./build_image.sh codex-pi-camera
```

The script uses `my-codex-docker-image` as its base by default. In
`BUILD_BASE_IMAGE=auto` mode it builds that image when missing and rebuilds it
when its versioned runtime contract or any shared control-plane asset is stale.
It verifies the same contract in the completed Camera image. Useful overrides:

```shell
CODEX_BASE_IMAGE_TAG=my-codex-docker-image
BUILD_BASE_IMAGE=auto
CODEX_RELEASE_TAG=rust-v0.145.0
```

The build installs Raspberry Pi camera packages only on `arm64`/`armhf` by
default:

```shell
INSTALL_RPICAM_PACKAGES=auto
RASPBERRY_PI_APT_SUITE=bookworm
```

Set `INSTALL_RPICAM_PACKAGES=false` to build a non-camera development image, or
`INSTALL_RPICAM_PACKAGES=true` to force the package install.

NCNN is built from a checksummed upstream full-source archive. CPU inference is
the default and works without GPU device access:

```shell
NCNN_VERSION=20260526
NCNN_SOURCE_SHA256=754659d6fe65545cf2ef4483ffb84526fea631f8764c44b150f1601d0fb4004b
NCNN_VULKAN=OFF
```

When changing `NCNN_VERSION`, also provide the SHA-256 digest published for that
release's `ncnn-<version>-full-source.zip` asset. To compile the optional Vulkan
backend and add the Mesa Vulkan runtime, set `NCNN_VULKAN=ON`. CPU inference
remains available in Vulkan builds. Validate Vulkan builds on the target Pi and
driver combination; a Docker build can confirm that support was compiled, but
cannot prove that a host GPU is usable.

Like `ext/docker/pi`, the build defaults to
`PLAYWRIGHT_BROWSER_SOURCE=system`. This is the recommended setting for
Raspberry Pi hosts because it skips Playwright-managed browser downloads during
`docker build` and uses the Debian Chromium wrapper at
`/opt/google/chrome/chrome`.

Use these overrides only when needed:

```shell
# Recommended default: skip browser downloads, use Debian Chromium.
PLAYWRIGHT_BROWSER_SOURCE=system ./build_image.sh

# Try Playwright-managed Chromium first, then fall back to system Chromium.
PLAYWRIGHT_BROWSER_SOURCE=auto ./build_image.sh

# Require Playwright-managed Chromium; fail if it cannot be installed.
PLAYWRIGHT_BROWSER_SOURCE=playwright ./build_image.sh

# Timeout for the Playwright-managed browser install attempt.
PLAYWRIGHT_BROWSER_SOURCE=auto PLAYWRIGHT_BROWSER_INSTALL_TIMEOUT_SEC=300 ./build_image.sh
```

Override `PLAYWRIGHT_MCP_EXECUTABLE_PATH` if you provide a different
Chromium-compatible executable inside the image.

## Run With Camera Devices

Use the launcher from the repo root or from this directory:

```shell
ext/docker/pi-camera/run_camera_container.sh
```

It maps these host devices when present:

- `/dev/video*`
- `/dev/media*`
- `/dev/v4l-subdev*`
- `/dev/dri/*`
- `/dev/dma_heap/*`
- `/dev/vchiq`, `/dev/vcsm-cma`, `/dev/vcio`

It also bind-mounts `/run/udev` read-only when available and adds the numeric
group IDs that own the mapped devices. The default security posture is:

```text
--security-opt no-new-privileges:true
--cap-drop=ALL
--sysctl net.ipv4.ping_group_range=0 2147483647
```

The ping sysctl enables ICMP echo through Linux ping sockets without granting
`NET_RAW` or disabling `no-new-privileges`.

If the launcher finds root-only character devices, it does not bind-mount those
nodes directly. Instead, it grants the matching device cgroup rule, adds
`--cap-add=MKNOD`, and lets the entrypoint create writable container-local
device nodes before dropping back to `node`. This avoids changing permissions on
the host `/dev` nodes.

Do not mount the Docker socket into this container.

Useful environment overrides:

```shell
CODEX_IMAGE_TAG=codex-pi-camera
CODEX_CONTAINER_NAME=codex-pi-camera
CODEX_WORKDIR_MOUNT="$PWD"
CODEX_DOCKER_NETWORK=bridge
PUBLISH_APP_SERVER_PORT=0
CODEX_DOCKER_EXTRA_ARGS=
```

To run a command directly:

```shell
ext/docker/pi-camera/run_camera_container.sh codex-camera-smoke-test
```

## Validate Camera Access

Inside the container:

```shell
codex-camera-smoke-test
```

For a metadata/tooling check without capturing frames:

```shell
codex-camera-smoke-test --no-capture
```

You can also run raw tools:

```shell
rpicam-hello --list-cameras
rpicam-vid -t 1000 -n --inline -o /tmp/test.h264
ffprobe /tmp/test.h264
```

## Validate Computer Vision and Inference

The hardware-independent smoke test converts a synthetic BGR image with OpenCV,
feeds the resulting tensor through an NCNN network, and checks the inference
output:

```shell
codex-vision-smoke-test
```

Codex can use both libraries directly from Python:

```python
import cv2
import ncnn
import numpy as np

frame = np.zeros((480, 640, 3), dtype=np.uint8)
gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
net = ncnn.Net()
```

The C++ headers and CMake package are under `/opt/ncnn`, and tools such as
`ncnnoptimize` are on `PATH`. The runtime consumes NCNN `.param` and `.bin`
models. Convert PyTorch or ONNX models with PNNX in a separate development
environment and mount the resulting files into the container; PyTorch and PNNX
are intentionally excluded from this image to keep the camera runtime smaller.

## RTP Streaming

The helper mirrors the low-latency shape of the target command:

```shell
codex-camera-rtp-stream 'rtp://receiver:5004?pkt_size=1200'
```

By default it transcodes with `libx264`, GOP 30, `ultrafast`, and
`zerolatency`. To avoid CPU-heavy transcoding when the camera is already
producing H.264:

```shell
FFMPEG_VCODEC=copy codex-camera-rtp-stream 'rtp://receiver:5004?pkt_size=1200'
```

The running streamer also writes `/tmp/codex-camera/latest.jpg` atomically at
one frame per second. This is the shared analysis input for OpenCV/NCNN and does
not interrupt browser RTP. Configure it with `CAMERA_LATEST_FRAME_PATH`,
`CAMERA_LATEST_FRAME_FPS`, and `CAMERA_LATEST_FRAME_QUALITY`; set the path to
`off` to disable it. Avoid starting another long-running `rpicam-vid`
process while the gateway streamer owns the device.

Codex can still run the exact raw pipeline directly:

```shell
rpicam-vid -t 0 --inline -o - \
  | ffmpeg -i - -c:v libx264 -g 30 -preset ultrafast -tune zerolatency \
      -f rtp 'rtp://receiver:5004?pkt_size=1200'
```

If the receiver is another container, put both containers on the same Docker
network and use the receiver container name instead of `127.0.0.1`. Inside
Docker, `127.0.0.1` means the current container.

## App Server Proxy

The app-server proxy is inherited directly from `ext/docker/pi`; Camera does
not maintain a private copy. That also provides the managed CLI auth broker and
the app-surface IPC socket when `CODEX_APP_SURFACE_CONTAINER=1` or
`APP_SERVER_APP_SURFACE_IPC_ENABLED=1`. Use `APP_SERVER_PROXY_TOKEN` for the
first-frame proxy handshake:

```json
{"type":"auth","token":"<APP_SERVER_PROXY_TOKEN>"}
```

To publish the app-server proxy only on the host loopback interface:

```shell
PUBLISH_APP_SERVER_PORT=1 ext/docker/pi-camera/run_camera_container.sh codex-app-server-proxy
```

For container-to-container access, prefer a private Docker network instead of a
published host port.

When the app-surface IPC socket is enabled, camera runtimes can use the same
helper as agent runtimes:

```shell
/home/node/app-surface-send.js state
/home/node/app-surface-send.js media side
/home/node/app-surface-send.js frame '{"type":"app.surface.html","title":"Camera Monitor","html":"<main>...</main>"}'
/home/node/app-surface-send.js status "Live analysis running"
```

The live camera RTP stream remains the media plane; app-surface frames should add
UI, overlays, monitoring state, controls, or alerts around that stream.
The RTP stream itself is not model input. `state` reports the atomic analysis
frame under `camera`, including its path, age, and availability. Gateway-driven
Codex and an interactive CLI share revisioned app-surface state and should use
`--if-revision` when both may publish.

## Runtime Audio RTP

The Chromium wrapper sources `/home/node/browser-audio-setup.sh` before launch.
That setup is also available as `/home/node/runtime-audio-setup.sh`; it starts a
user PulseAudio daemon, creates the `codex_runtime_sink` null sink, and makes it
the default runtime audio output. Browser audio, media players, and other
PulseAudio-aware apps can all be captured through the sink. Stream the monitor
as Opus RTP with:

```shell
codex-runtime-audio-rtp-stream 'rtp://receiver:5006?pkt_size=1200'
```

By default the helper uses `CODEX_RUNTIME_AUDIO_CAPTURE=auto`: it captures the
PulseAudio monitor when available and falls back to lavfi silence. For an audio
path test, force a tone:

```shell
CODEX_RUNTIME_AUDIO_CAPTURE=lavfi \
CODEX_RUNTIME_AUDIO_SRC='sine=frequency=440:sample_rate=48000' \
codex-runtime-audio-rtp-stream 'rtp://receiver:5006?pkt_size=1200'
```

The older `codex-browser-audio-*` command names and `CODEX_BROWSER_AUDIO_*`
variables remain compatibility aliases.

## Security Notes

This is intentionally stronger than running Codex directly on the host, but it
is not VM isolation. The container shares the host kernel and selected camera
devices with the host. Keep the device set narrow, avoid `--privileged`, avoid
host-root filesystem mounts, and keep the Docker daemon socket out of the
container.

Docker documents `--device` as the non-privileged way to expose selected host
devices to containers, while `--privileged` grants broad host device access and
should be treated as a last-resort debugging mode.

References:

- Docker runtime privilege and `--device` documentation:
  https://docs.docker.com/engine/containers/run/
- Raspberry Pi camera software documentation:
  https://www.raspberrypi.com/documentation/computers/camera_software.html
