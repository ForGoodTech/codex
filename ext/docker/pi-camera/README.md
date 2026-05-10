# Codex Docker Image for Pi Camera

This directory is a camera-enabled sibling of `ext/docker/pi`. The original
image stays intact; this variant keeps the Codex CLI, app-server proxy,
SDK proxy, MCP configuration, and Playwright/Chrome tooling, then adds a
Raspberry Pi camera runtime for agentic camera work inside Docker.

## What gets added

- `ffmpeg` and `v4l-utils` from Debian.
- `rpicam-apps-core` and `rpicam-apps-encoder` from the Raspberry Pi Bookworm
  apt archive on `arm64` and `armhf` builds.
- `codex-camera-smoke-test`, a container-side camera/device sanity check.
- `codex-camera-rtp-stream`, a container-side RTP helper around
  `rpicam-vid | ffmpeg`.
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

The build installs Raspberry Pi camera packages only on `arm64`/`armhf` by
default:

```shell
INSTALL_RPICAM_PACKAGES=auto
RASPBERRY_PI_APT_SUITE=bookworm
```

Set `INSTALL_RPICAM_PACKAGES=false` to build a non-camera development image, or
`INSTALL_RPICAM_PACKAGES=true` to force the package install.

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
```

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

The app-server proxy behavior is copied from `ext/docker/pi`. Use
`APP_SERVER_PROXY_TOKEN` for the first-frame proxy handshake:

```json
{"type":"auth","token":"<APP_SERVER_PROXY_TOKEN>"}
```

To publish the app-server proxy only on the host loopback interface:

```shell
PUBLISH_APP_SERVER_PORT=1 ext/docker/pi-camera/run_camera_container.sh codex-app-server-proxy
```

For container-to-container access, prefer a private Docker network instead of a
published host port.

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
