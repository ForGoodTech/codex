ARG BASE_IMAGE=my-codex-docker-image
FROM ${BASE_IMAGE}

USER root

ENV DEBIAN_FRONTEND=noninteractive
ENV WEBDEV_WORKSPACE=/workspace
ENV WEBDEV_CONFIG=/workspace/sites.json
ENV WEBDEV_STATE_DIR=/home/node/.webdev

RUN apt-get update && apt-get install -y --no-install-recommends \
  build-essential \
  composer \
  default-mysql-client \
  gettext-base \
  gosu \
  lsof \
  nginx \
  openssl \
  php-bcmath \
  php-cli \
  php-curl \
  php-fpm \
  php-gd \
  php-intl \
  php-mbstring \
  php-mysql \
  php-xml \
  php-zip \
  pkg-config \
  python3 \
  rsync \
  zip \
  && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
  php_version="$(php -r 'echo PHP_MAJOR_VERSION.".".PHP_MINOR_VERSION;')"; \
  pool_conf="/etc/php/${php_version}/fpm/pool.d/www.conf"; \
  sed -i 's|^listen = .*|listen = /run/php/php-fpm.sock|' "$pool_conf"; \
  sed -i 's|^user = .*|user = node|' "$pool_conf"; \
  sed -i 's|^group = .*|group = node|' "$pool_conf"; \
  if grep -q '^;*listen.owner = ' "$pool_conf"; then \
    sed -i 's|^;*listen.owner = .*|listen.owner = www-data|' "$pool_conf"; \
  else \
    printf '%s\n' 'listen.owner = www-data' >> "$pool_conf"; \
  fi; \
  if grep -q '^;*listen.group = ' "$pool_conf"; then \
    sed -i 's|^;*listen.group = .*|listen.group = www-data|' "$pool_conf"; \
  else \
    printf '%s\n' 'listen.group = www-data' >> "$pool_conf"; \
  fi; \
  if grep -q '^;*listen.mode = ' "$pool_conf"; then \
    sed -i 's|^;*listen.mode = .*|listen.mode = 0660|' "$pool_conf"; \
  else \
    printf '%s\n' 'listen.mode = 0660' >> "$pool_conf"; \
  fi; \
  if grep -q '^;*clear_env = ' "$pool_conf"; then \
    sed -i 's|^;*clear_env = .*|clear_env = no|' "$pool_conf"; \
  else \
    printf '%s\n' 'clear_env = no' >> "$pool_conf"; \
  fi; \
  php_fpm_bin="$(find /usr/sbin -maxdepth 1 -type f -name 'php-fpm*' | sort | head -n 1)"; \
  test -n "$php_fpm_bin"; \
  ln -sf "$php_fpm_bin" /usr/local/bin/php-fpm-webdev; \
  rm -f /etc/nginx/sites-enabled/default; \
  mkdir -p /home/node/.webdev/nginx /workspace; \
  : > /home/node/.webdev/nginx/empty.conf; \
  chown -R node:node /home/node/.webdev /workspace; \
  printf '%s\n' 'include /home/node/.webdev/nginx/*.conf;' > /etc/nginx/conf.d/99-webdev-sites.conf

COPY ext/docker/pi-web/bin/webdev /usr/local/bin/webdev
COPY ext/docker/pi-web/bin/webdev-entrypoint /usr/local/bin/webdev-entrypoint
RUN chmod 755 /usr/local/bin/webdev /usr/local/bin/webdev-entrypoint

WORKDIR /workspace
EXPOSE 80 443 5173-5199
ENTRYPOINT ["webdev-entrypoint"]
CMD ["bash"]
