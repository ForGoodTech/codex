ARG BASE_IMAGE=my-codex-docker-image
ARG NCNN_VERSION="20260526"
ARG NCNN_SOURCE_SHA256="754659d6fe65545cf2ef4483ffb84526fea631f8764c44b150f1601d0fb4004b"
ARG NCNN_VULKAN="OFF"

FROM node:24-bookworm AS ncnn-builder

ARG NCNN_VERSION
ARG NCNN_SOURCE_SHA256
ARG NCNN_VULKAN

RUN set -eux; \
    case "${NCNN_VULKAN}" in \
      ON|OFF) ;; \
      *) echo "Unsupported NCNN_VULKAN=${NCNN_VULKAN}; expected ON or OFF" >&2; exit 1 ;; \
    esac; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      cmake \
      curl \
      libprotobuf-dev \
      ninja-build \
      protobuf-compiler \
      python3-dev \
      python3-numpy \
      python3-pip \
      python3-setuptools \
      python3-wheel \
      unzip; \
    if [ "${NCNN_VULKAN}" = "ON" ]; then \
      apt-get install -y --no-install-recommends glslang-tools libvulkan-dev; \
    fi; \
    rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    mkdir -p /tmp/ncnn-source /tmp/ncnn-wheel /opt/ncnn /opt/ncnn-python; \
    curl --fail --location --show-error --silent --retry 3 \
      "https://github.com/Tencent/ncnn/releases/download/${NCNN_VERSION}/ncnn-${NCNN_VERSION}-full-source.zip" \
      --output /tmp/ncnn.zip; \
    printf '%s  %s\n' "${NCNN_SOURCE_SHA256}" /tmp/ncnn.zip | sha256sum --check --strict -; \
    unzip -q /tmp/ncnn.zip -d /tmp/ncnn-source; \
    cmake -S /tmp/ncnn-source -B /tmp/ncnn-build -G Ninja \
      -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_INSTALL_PREFIX=/opt/ncnn \
      -DNCNN_BUILD_BENCHMARK=OFF \
      -DNCNN_BUILD_EXAMPLES=OFF \
      -DNCNN_BUILD_TESTS=OFF \
      -DNCNN_BUILD_TOOLS=ON \
      -DNCNN_DISABLE_EXCEPTION=OFF \
      -DNCNN_DISABLE_RTTI=OFF \
      -DNCNN_PYTHON=ON \
      -DNCNN_SHARED_LIB=ON \
      -DNCNN_VERSION="${NCNN_VERSION}" \
      -DNCNN_VULKAN="${NCNN_VULKAN}" \
      -DPYTHON_EXECUTABLE=/usr/bin/python3 \
      -DPython_EXECUTABLE=/usr/bin/python3 \
      -DPython3_EXECUTABLE=/usr/bin/python3; \
    cmake --build /tmp/ncnn-build --parallel "$(nproc)"; \
    cmake --install /tmp/ncnn-build; \
    python3 -m pip wheel \
      --no-build-isolation \
      --no-deps \
      --wheel-dir /tmp/ncnn-wheel \
      /tmp/ncnn-source/python; \
    python3 -m pip install \
      --no-deps \
      --no-index \
      --target /opt/ncnn-python \
      /tmp/ncnn-wheel/ncnn-*.whl

FROM ${BASE_IMAGE}

ARG NCNN_VERSION
ARG NCNN_VULKAN
ARG INSTALL_RPICAM_PACKAGES="auto"
ARG RASPBERRY_PI_APT_SUITE="bookworm"

ENV NCNN_VERSION="${NCNN_VERSION}"
ENV NCNN_VULKAN="${NCNN_VULKAN}"

USER root

# Install only camera/vision additions here. Codex, its proxy, the managed
# auth broker, MCP tooling, browser/audio helpers, and default config are
# inherited from the versioned Pi runtime base image.
RUN set -eux; \
    case "${NCNN_VULKAN}" in \
      ON|OFF) ;; \
      *) echo "Unsupported NCNN_VULKAN=${NCNN_VULKAN}; expected ON or OFF" >&2; exit 1 ;; \
    esac; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      libgomp1 \
      libprotobuf32 \
      python3 \
      python3-numpy \
      python3-opencv \
      python3-portalocker \
      python3-requests \
      python3-tqdm \
      util-linux \
      v4l-utils; \
    if [ "${NCNN_VULKAN}" = "ON" ]; then \
      apt-get install -y --no-install-recommends libvulkan1 mesa-vulkan-drivers; \
    fi; \
    rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    install_rpicam="0"; \
    case "${INSTALL_RPICAM_PACKAGES}" in \
      auto) \
        case "$arch" in \
          arm64|armhf) install_rpicam="1" ;; \
        esac; \
        ;; \
      1|true|yes) install_rpicam="1" ;; \
      0|false|no) install_rpicam="0" ;; \
      *) echo "Unsupported INSTALL_RPICAM_PACKAGES=${INSTALL_RPICAM_PACKAGES}" >&2; exit 1 ;; \
    esac; \
    if [ "$install_rpicam" = "1" ]; then \
      mkdir -p /usr/share/keyrings; \
      curl -fsSL https://archive.raspberrypi.com/debian/raspberrypi.gpg.key \
        | gpg --dearmor -o /usr/share/keyrings/raspberrypi-archive-keyring.gpg; \
      echo "deb [arch=${arch} signed-by=/usr/share/keyrings/raspberrypi-archive-keyring.gpg] http://archive.raspberrypi.com/debian ${RASPBERRY_PI_APT_SUITE} main" \
        > /etc/apt/sources.list.d/raspberrypi.list; \
      apt-get update; \
      apt-get install -y --no-install-recommends \
        rpicam-apps-core \
        rpicam-apps-encoder \
        rpicam-apps-opencv-postprocess; \
      rm -rf /var/lib/apt/lists/*; \
    else \
      echo "Skipping Raspberry Pi camera packages for architecture ${arch}."; \
    fi

COPY --from=ncnn-builder /opt/ncnn /opt/ncnn
COPY --from=ncnn-builder /opt/ncnn-python /opt/ncnn-python
ENV PATH="/opt/ncnn/bin:${PATH}"
ENV LD_LIBRARY_PATH="/opt/ncnn/lib"
ENV PYTHONPATH="/opt/ncnn-python"

COPY --chown=node:node ext/docker/pi-camera/camera-smoke-test.sh /home/node/camera-smoke-test.sh
COPY --chown=node:node ext/docker/pi-camera/camera-rtp-stream.sh /home/node/camera-rtp-stream.sh
COPY --chown=node:node ext/docker/pi-camera/vision-smoke-test.sh /home/node/vision-smoke-test.sh
RUN chmod 755 /home/node/camera-smoke-test.sh /home/node/camera-rtp-stream.sh /home/node/vision-smoke-test.sh && \
  ln -sf /home/node/camera-smoke-test.sh /usr/local/share/npm-global/bin/codex-camera-smoke-test && \
  ln -sf /home/node/camera-rtp-stream.sh /usr/local/share/npm-global/bin/codex-camera-rtp-stream && \
  ln -sf /home/node/vision-smoke-test.sh /usr/local/share/npm-global/bin/codex-vision-smoke-test

# Start as root only long enough to create container-local device nodes for
# host devices that are root-only, then drop back to node before running Codex.
COPY ext/docker/pi-camera/camera-device-setup.sh /usr/local/bin/codex-camera-device-setup
COPY ext/docker/pi-camera/camera-entrypoint.sh /usr/local/bin/codex-camera-entrypoint
RUN chmod 755 /usr/local/bin/codex-camera-device-setup /usr/local/bin/codex-camera-entrypoint
ENV HOME=/home/node
ENV USER=node
ENV LOGNAME=node
ENTRYPOINT ["codex-camera-entrypoint"]
