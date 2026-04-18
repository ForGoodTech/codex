# Codex Firecracker Build for Pi

This directory builds a bootable guest root filesystem for running the Codex
app-server proxy inside a disposable Firecracker microVM.

The intent is similar to `codex/ext/docker/pi`, but the build output is a
Firecracker-oriented VM artifact instead of a Docker image. The gateway can
later boot disposable microVMs from this base rootfs and connect to the proxy
inside the guest.

## What gets built

The main build script produces tangible artifacts under:

```text
target/codex-vm/pi/<codex-release>/<arch>/
```

For the optional SSH-enabled debug profile, artifacts go under:

```text
target/codex-vm/pi/<codex-release>/<arch>/debug-ssh/
```

Typical outputs:

- `rootfs.ext4`: immutable base guest root filesystem image
- `manifest.json`: build metadata for the rootfs
- `firecracker.boot_args`: boot args used for Firecracker guests
- `firecracker_vm_config.template.json`: host-side template for a Firecracker VM config
- `payload/`: temporary staged inputs used during the build

This directory does not currently build or manage:

- gateway launch integration
- gateway spawn logic
- front-end changes
- a guest kernel image

The kernel is intentionally treated as an external host-managed dependency for
now. The gateway/runtime work can wire that in later, but the artifacts here are
laid out specifically for Firecracker:

- ext4 rootfs on `/dev/vda`
- serial console on `ttyS0`
- DHCP enabled on `eth0`
- `systemd` service logs mirrored to console for boot verification

## Guest layout

The rootfs is based on Debian Bookworm and provisions:

- Node.js
- Codex CLI and bundled vendor binaries
- `codex-app-server-proxy`
- `codex-sdk-proxy`
- Chromium/Playwright-related host packages
- a default `/home/node/.codex/config.toml`
- a `systemd` service that starts the TCP proxy on boot
- Firecracker-friendly hostname, fstab, machine-id reset, and network defaults

The proxy service listens on port `9395` by default, matching the current
gateway expectation.

## Prerequisites

The build is host-driven and expects Linux with root access. Typical host
packages:

```sh
sudo apt-get update
sudo apt-get install -y \
  debootstrap \
  dosfstools \
  e2fsprogs \
  mount \
  rsync \
  sudo \
  systemd-container \
  xz-utils
```

Additional host requirements:

- Docker is not required for this build path.
- `pnpm`, `npm`, `curl`, and `tar` must be available on the host.
- The host should build natively for the target architecture. Cross-arch rootfs
  creation is intentionally out of scope for this first pass.
- Firecracker is only needed for the smoke test, not for the rootfs build.

## Build

From the repository root:

```sh
codex/ext/vm/pi/build_rootfs.sh
```

Common overrides:

```sh
ROOTFS_SIZE_GB=14 \
CODEX_RELEASE_TAG=rust-v0.118.0 \
NODE_VERSION=24.11.0 \
KERNEL_IMAGE=/path/to/kernel-image \
codex/ext/vm/pi/build_rootfs.sh
```

## Firecracker smoke test

Once the rootfs and a compatible kernel are available, a local host-side smoke
test can boot the image directly with Firecracker and watch the serial console
for proxy startup:

```sh
KERNEL_IMAGE=/path/to/kernel-image \
codex/ext/vm/pi/smoke_test_firecracker.sh
```

`KERNEL_IMAGE` must match the host architecture and Firecracker's loader
expectations. In particular, `aarch64` hosts need an arm64 guest kernel image
that Firecracker can load on ARM; a filename like `vmlinux` by itself is not a
guarantee that the image is usable.

This does not involve the gateway yet. It is only intended to answer the first
question: "does the guest boot under Firecracker and start the Codex proxy?"

## Runtime assumptions

The guest rootfs starts `codex-app-server-proxy` as user `node` via
`systemd`. The service reads optional overrides from:

```text
/etc/codex-proxy.env
```

That keeps the future gateway work simple: boot guest, inject env or writable
state, then connect to the proxy process over the chosen transport.

## Debug SSH Profile

For development and bring-up, this directory now supports a deterministic
`debug-ssh` profile that makes the guest reachable over SSH from the host while
keeping the existing minimal profile unchanged.

What the debug profile changes:

- installs `openssh-server`
- enables `ssh.service`
- provisions `authorized_keys` for the chosen SSH user
- configures static guest networking on `eth0`
- emits manifest metadata used by the host-side launch and smoke scripts

The debug profile does not add password login. SSH remains key-only.

### Build the debug-ssh rootfs

You must provide a public key file to bake into the guest image.

```sh
VM_PROFILE=debug-ssh \
DEBUG_SSH_AUTHORIZED_KEYS_FILE=/absolute/path/to/id_ed25519.pub \
KERNEL_IMAGE=/absolute/path/to/kernel-image \
codex/ext/vm/pi/build_rootfs.sh
```

Useful deterministic overrides:

```sh
VM_PROFILE=debug-ssh \
DEBUG_SSH_AUTHORIZED_KEYS_FILE=/absolute/path/to/id_ed25519.pub \
DEBUG_SSH_USER=node \
DEBUG_SSH_HOST_IP_CIDR=172.16.0.1/24 \
DEBUG_SSH_GUEST_IP_CIDR=172.16.0.2/24 \
DEBUG_SSH_GUEST_MAC=06:00:ac:10:00:02 \
KERNEL_IMAGE=/absolute/path/to/kernel-image \
codex/ext/vm/pi/build_rootfs.sh
```

### Run an interactive debug VM with SSH

This script creates a TAP device on the host, boots the VM, waits for SSH, then
prints the exact login command and keeps streaming the serial console in the
current terminal.

Leave that terminal running and use a second terminal for SSH.

```sh
ARTIFACT_ROOT=/absolute/path/to/target/codex-vm/pi/rust-v0.118.0/$(uname -m)/debug-ssh \
KERNEL_IMAGE=/absolute/path/to/kernel-image \
FIRECRACKER_BIN=/absolute/path/to/firecracker \
DEBUG_SSH_PRIVATE_KEY_FILE=/absolute/path/to/id_ed25519 \
codex/ext/vm/pi/run_firecracker_debug_ssh.sh
```

The script requires host privileges to create/configure the TAP device, so it
will invoke `sudo ip ...` during setup and teardown.

### SSH smoke test

This smoke test boots the same `debug-ssh` profile, waits for SSH to become
reachable, and then verifies the observable debug state inside the guest:
`sshd` is running, the proxy process exists, and the guest is listening on
ports `22` and `9395`.

```sh
ARTIFACT_ROOT=/absolute/path/to/target/codex-vm/pi/rust-v0.118.0/$(uname -m)/debug-ssh \
KERNEL_IMAGE=/absolute/path/to/kernel-image \
FIRECRACKER_BIN=/absolute/path/to/firecracker \
DEBUG_SSH_PRIVATE_KEY_FILE=/absolute/path/to/id_ed25519 \
codex/ext/vm/pi/smoke_test_firecracker_ssh.sh
```

### App-server protocol smoke test

This is the highest-signal VM smoke test for later gateway integration. It
boots the `debug-ssh` profile, waits for the guest network to come up, then
connects from the host to the guest's proxy on port `9395` and performs the
actual JSONL app-server handshake:

- proxy auth frame
- `initialize`
- `initialized`
- lightweight follow-up requests (`getAuthStatus`, `config/read`, `model/list`)

If this test passes, the VM is not merely booted; the proxy and app server are
serving protocol traffic.

```sh
ARTIFACT_ROOT=/absolute/path/to/target/codex-vm/pi/rust-v0.118.0/$(uname -m)/debug-ssh \
KERNEL_IMAGE=/absolute/path/to/kernel-image \
FIRECRACKER_BIN=/absolute/path/to/firecracker \
DEBUG_SSH_PRIVATE_KEY_FILE=/absolute/path/to/id_ed25519 \
codex/ext/vm/pi/smoke_test_firecracker_app_server.sh
```

If your proxy is configured with a non-empty handshake token, also set:

```sh
APP_SERVER_PROXY_TOKEN=<token>
```

### Two-terminal workflow

1. In terminal 1, run `run_firecracker_debug_ssh.sh`.
2. Wait for it to print the `ssh -i ... node@...` command.
3. In terminal 2, run that SSH command and inspect the guest normally.
4. Use terminal 1 for live serial logs and terminal 2 as your remote shell.
