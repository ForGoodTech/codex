# Codex Firecracker Build for Pi

This directory builds a bootable guest root filesystem for running the Codex
app-server proxy inside a disposable Firecracker microVM.

The procedure below is written for this checkout layout:

- Codex repo root: `/media/workdisk/repos/codex`
- Firecracker working area: `/media/workdisk/firecracker`
- Build artifacts: `/media/workdisk/build/codex-vm`

These steps assume the checkout at `/media/workdisk/repos/codex` already
contains the `ext/vm/pi` work, including:

- `ext/vm/pi/build_rootfs.sh`
- `ext/vm/pi/run_firecracker_debug_ssh.sh`
- `ext/vm/pi/smoke_test_firecracker_ssh.sh`
- `ext/vm/pi/smoke_test_firecracker_app_server.sh`

## What gets built

The main build script produces Firecracker-oriented artifacts under the chosen
`OUTPUT_ROOT`.

For the paths used in this README:

- default profile: `/media/workdisk/build/codex-vm/aarch64`
- debug SSH profile: `/media/workdisk/build/codex-vm/aarch64/debug-ssh`

Typical outputs:

- `rootfs.ext4`: base guest root filesystem image
- `manifest.json`: build metadata for the rootfs
- `firecracker.boot_args`: boot args used for Firecracker guests
- `firecracker_vm_config.template.json`: host-side Firecracker config template
- `payload/`: staged inputs used during the build

This directory does not currently build or manage:

- gateway launch integration
- gateway spawn logic
- front-end changes
- a guest kernel image

The kernel is intentionally treated as an external host-managed dependency.

## Directory layout

Use these locations consistently:

```text
/media/workdisk/repos/codex
/media/workdisk/firecracker/bin
/media/workdisk/firecracker/src
/media/workdisk/firecracker/kernels
/media/workdisk/firecracker/keys
/media/workdisk/build/codex-vm
```

## One-time host prerequisites

Install the host packages needed for the rootfs build and smoke tests:

```bash
sudo apt-get update
sudo apt-get install -y \
  debootstrap \
  dosfstools \
  e2fsprogs \
  mount \
  rsync \
  sudo \
  systemd-container \
  xz-utils \
  jq \
  curl \
  npm \
  pnpm \
  iproute2 \
  openssh-client
```

Make sure KVM is usable by your user:

```bash
ls -l /dev/kvm
getent group kvm
groups
[ -r /dev/kvm ] && [ -w /dev/kvm ] && echo OK || echo FAIL
```

If needed, grant access via the `kvm` group:

```bash
sudo usermod -aG kvm "$USER"
newgrp kvm
```

If your machine uses ACLs instead:

```bash
sudo setfacl -m u:$USER:rw /dev/kvm
```

## Build the TypeScript SDK first

`ext/vm/pi/build_rootfs.sh` requires `sdk/typescript/dist` to already exist.
If your checkout does not already have a built SDK, build it first:

```bash
cd /media/workdisk/repos/codex/sdk/typescript
pnpm install
pnpm build
```

Then return to the repo root:

```bash
cd /media/workdisk/repos/codex
```

Nuance:

- `build_rootfs.sh` already runs `pnpm install` and `pnpm pack` for `codex-cli`
- it does not build `sdk/typescript` for you

## Firecracker binary

If you do not already have Firecracker at the expected location, download a
release build:

```bash
mkdir -p /media/workdisk/firecracker/bin
cd /media/workdisk/firecracker/bin

ARCH="$(uname -m)"
release_url="https://github.com/firecracker-microvm/firecracker/releases"
latest=$(basename "$(curl -fsSLI -o /dev/null -w %{url_effective} ${release_url}/latest)")
curl -L "${release_url}/download/${latest}/firecracker-${latest}-${ARCH}.tgz" | tar -xz
mv "release-${latest}-${ARCH}/firecracker-${latest}-${ARCH}" firecracker
chmod +x firecracker
```

Expected path:

```text
/media/workdisk/firecracker/bin/firecracker
```

## Kernel build

The critical detail is to build `Image`, not `vmlinux`.

Set up the source working area:

```bash
mkdir -p /media/workdisk/firecracker/src
mkdir -p /media/workdisk/firecracker/kernels
cd /media/workdisk/firecracker/src
```

Fetch Firecracker and Linux source:

```bash
git clone --depth 1 https://github.com/firecracker-microvm/firecracker.git
git clone --depth 1 --branch v6.1 https://github.com/torvalds/linux.git
```

Build the ARM guest kernel using Firecracker's `aarch64` guest config:

```bash
cd /media/workdisk/firecracker/src/linux

cp /media/workdisk/firecracker/src/firecracker/resources/guest_configs/microvm-kernel-ci-aarch64-6.1.config .config
make ARCH=arm64 olddefconfig
make ARCH=arm64 -j"$(nproc)" Image
cp arch/arm64/boot/Image /media/workdisk/firecracker/kernels/Image
```

Verify the result:

```bash
ls -lh /media/workdisk/firecracker/kernels/Image
file /media/workdisk/firecracker/kernels/Image
```

Use this exact kernel path later:

```text
/media/workdisk/firecracker/kernels/Image
```

## SSH key for the debug VM

Create the debug key once:

```bash
mkdir -p /media/workdisk/firecracker/keys
ssh-keygen -t ed25519 -f /media/workdisk/firecracker/keys/codex-debug -N ''
```

This gives you:

- public key: `/media/workdisk/firecracker/keys/codex-debug.pub`
- private key: `/media/workdisk/firecracker/keys/codex-debug`

## Build the debug SSH rootfs

From the Codex repo root:

```bash
cd /media/workdisk/repos/codex

VM_PROFILE=debug-ssh \
OUTPUT_ROOT=/media/workdisk/build/codex-vm \
DEBUG_SSH_AUTHORIZED_KEYS_FILE=/media/workdisk/firecracker/keys/codex-debug.pub \
DEBUG_SSH_USER=node \
DEBUG_SSH_HOST_IP_CIDR=172.16.0.1/24 \
DEBUG_SSH_GUEST_IP_CIDR=172.16.0.2/24 \
DEBUG_SSH_GUEST_MAC=06:00:ac:10:00:02 \
KERNEL_IMAGE=/media/workdisk/firecracker/kernels/Image \
bash ext/vm/pi/build_rootfs.sh
```

This produces the debug artifact here:

```text
/media/workdisk/build/codex-vm/aarch64/debug-ssh
```

## Best validation: app-server protocol smoke test

This is the highest-signal test. It proves the proxy and app server serve real
protocol traffic.

Run:

```bash
cd /media/workdisk/repos/codex

ARTIFACT_ROOT=/media/workdisk/build/codex-vm/aarch64/debug-ssh \
KERNEL_IMAGE=/media/workdisk/firecracker/kernels/Image \
FIRECRACKER_BIN=/media/workdisk/firecracker/bin/firecracker \
DEBUG_SSH_PRIVATE_KEY_FILE=/media/workdisk/firecracker/keys/codex-debug \
bash ext/vm/pi/smoke_test_firecracker_app_server.sh
```

Ideal result:

```text
App server protocol smoke test passed.
Proxy endpoint: 172.16.0.2:9395
User agent: ...
Auth method: (unknown)
Requires OpenAI auth: true
Sandbox mode: danger-full-access
Models returned: 6
```

Interpretation:

- `Auth method: (unknown)` is acceptable
- `Requires OpenAI auth: true` is expected
- `Models returned: 6` proves the app server is alive and answering JSON-RPC

If your proxy uses a non-empty handshake token, also set:

```bash
APP_SERVER_PROXY_TOKEN=<token>
```

## Two-terminal debug workflow

If you want a live VM plus an SSH shell:

Terminal 1:

```bash
cd /media/workdisk/repos/codex

ARTIFACT_ROOT=/media/workdisk/build/codex-vm/aarch64/debug-ssh \
KERNEL_IMAGE=/media/workdisk/firecracker/kernels/Image \
FIRECRACKER_BIN=/media/workdisk/firecracker/bin/firecracker \
DEBUG_SSH_PRIVATE_KEY_FILE=/media/workdisk/firecracker/keys/codex-debug \
bash ext/vm/pi/run_firecracker_debug_ssh.sh
```

Terminal 2:

Use the printed SSH command, or this default:

```bash
ssh -i /media/workdisk/firecracker/keys/codex-debug \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/tmp/codex-vm-known-hosts \
  node@172.16.0.2
```

Seeing a serial login prompt in terminal 1 is normal. That is the fallback
console, not a failure.

## Optional lower-level smoke tests

Boot only:

```bash
cd /media/workdisk/repos/codex

ARTIFACT_ROOT=/media/workdisk/build/codex-vm/aarch64/debug-ssh \
KERNEL_IMAGE=/media/workdisk/firecracker/kernels/Image \
FIRECRACKER_BIN=/media/workdisk/firecracker/bin/firecracker \
bash ext/vm/pi/smoke_test_firecracker_boot_only.sh
```

SSH only:

```bash
cd /media/workdisk/repos/codex

ARTIFACT_ROOT=/media/workdisk/build/codex-vm/aarch64/debug-ssh \
KERNEL_IMAGE=/media/workdisk/firecracker/kernels/Image \
FIRECRACKER_BIN=/media/workdisk/firecracker/bin/firecracker \
DEBUG_SSH_PRIVATE_KEY_FILE=/media/workdisk/firecracker/keys/codex-debug \
bash ext/vm/pi/smoke_test_firecracker_ssh.sh
```

These are useful, but the app-server protocol smoke test is the real milestone.

## Production-lean profile

If you also want the non-debug artifact, build the default profile separately:

```bash
cd /media/workdisk/repos/codex

OUTPUT_ROOT=/media/workdisk/build/codex-vm \
KERNEL_IMAGE=/media/workdisk/firecracker/kernels/Image \
bash ext/vm/pi/build_rootfs.sh
```

That produces:

```text
/media/workdisk/build/codex-vm/aarch64
```

Then run the original minimal smoke test:

```bash
cd /media/workdisk/repos/codex

ARTIFACT_ROOT=/media/workdisk/build/codex-vm/aarch64 \
KERNEL_IMAGE=/media/workdisk/firecracker/kernels/Image \
FIRECRACKER_BIN=/media/workdisk/firecracker/bin/firecracker \
bash ext/vm/pi/smoke_test_firecracker.sh
```

Interpret that test narrowly:

- it is only a proxy-start smoke test
- it is weaker than the app-server protocol smoke test

## Recommended shortest successful path

If you want the cleanest end-to-end reproduction of the correct result, use
this sequence:

1. Build `sdk/typescript`
2. Build the kernel `Image`
3. Create the debug SSH key
4. Build `VM_PROFILE=debug-ssh`
5. Run `ext/vm/pi/smoke_test_firecracker_app_server.sh`

That is the most direct path to a meaningful, reproducible success case.
