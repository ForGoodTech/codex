# Codex Pi Web Development Image

This directory builds a generic web-development sibling of `ext/docker/pi`.
The image contains the reusable tooling. Websites, domains, certificates,
databases, and secrets stay outside the image in a host-mounted workspace.

## What Is In The Image

- Everything from the base Pi Codex image.
- Nginx for HTTPS reverse proxying.
- PHP-FPM, PHP CLI, Composer, and common PHP extensions including MySQL support.
- MySQL client tools.
- Node/npm/Vite workflow support from the base Node image.
- Packaging helpers through the `webdev` command.

The image does not contain site domains or website source trees.

## Host Workspace Layout

Use any host directory as the workspace. A typical layout is:

```text
workspace/
  sites.json
  sites/
    app.local.test/
  certs/
    dev/
      fullchain.pem
      privkey.pem
  mysql-init/
```

`sites.json` is the only registry the scripts read:

```json
{
  "defaults": {
    "cert": {
      "fullchain": "/workspace/certs/dev/fullchain.pem",
      "key": "/workspace/certs/dev/privkey.pem"
    }
  },
  "sites": [
    {
      "name": "app",
      "host": "app.local.test",
      "root": "/workspace/sites/app.local.test",
      "vitePort": 5173,
      "mode": "vite"
    }
  ]
}
```

Set `mode` to `vite` when Nginx should proxy HTTPS traffic to a Vite dev
server. Set `mode` to `php` when Nginx should serve the packaged PHP output.

## Build

From the repository root:

```shell
cd ext/docker/pi-web
./build_image.sh
```

The default image tag is `my-codex-pi-web-image`. Override it with:

```shell
./build_image.sh codex-pi-web
```

The script uses `my-codex-docker-image` as the base image by default. If that
base image is missing, it builds `ext/docker/pi` first. Useful overrides:

```shell
CODEX_BASE_IMAGE_TAG=my-codex-docker-image
BUILD_BASE_IMAGE=auto
CODEX_RELEASE_TAG=rust-v0.142.3
```

## Run With Docker

Mount a host workspace and start Nginx/PHP-FPM:

```shell
WEBDEV_WORKSPACE_MOUNT="$PWD/workspace" \
ext/docker/pi-web/run_web_container.sh
```

The launcher publishes:

- `127.0.0.1:80` to container port `80`
- `127.0.0.1:443` to container port `443`
- `127.0.0.1:5173-5199` to Vite ports `5173-5199`

Run a shell instead of the web services:

```shell
WEBDEV_WORKSPACE_MOUNT="$PWD/workspace" \
ext/docker/pi-web/run_web_container.sh bash
```

## Run With Compose

The compose file adds a separate MySQL service:

```shell
cd ext/docker/pi-web
WEBDEV_WORKSPACE_MOUNT=/absolute/path/to/workspace docker compose up
```

MySQL data is stored in a Docker volume. Put your database initialization files
in the host directory configured by `WEBDEV_MYSQL_INIT_DIR` if you want MySQL's
official entrypoint to load them.

## Add A Website

Inside the container:

```shell
webdev init-site app.local.test
```

This creates a starter Vite app under `/workspace/sites/<host>` and adds a
site entry to `/workspace/sites.json`. You can pass an explicit root and port:

```shell
webdev init-site app.local.test /workspace/sites/app 5173
```

To add your development domains, run `webdev init-site` once per domain in your
host workspace. They are not baked into the image or scripts.

## Development Modes

Direct Vite development:

```shell
webdev dev app.local.test
```

That runs:

```shell
npm run dev -- --host 0.0.0.0 --port <vitePort>
```

Then visit the direct Vite URL:

```text
http://<host>:5173/
```

HTTPS reverse proxy development:

1. Keep the site `mode` as `vite` in `sites.json`.
2. Start Nginx/PHP-FPM with `webdev serve`.
3. Start Vite with `webdev dev <site>`.
4. Visit `https://<configured-domain>/`.

Nginx forwards websocket upgrade headers so Vite HMR can work through HTTPS.

Packaged PHP mode:

```shell
webdev package app.local.test
```

The package command runs the site's build, then copies built `dist/index.html`
to `dist/index.php`. Static HTML is valid PHP, so this gives a production entry
point while preserving the Vite development entry point.

Switch the site to packaged serving:

```json
{
  "host": "app.local.test",
  "root": "/workspace/sites/app.local.test",
  "mode": "php"
}
```

Regenerate and reload Nginx by restarting `webdev serve`, or run:

```shell
webdev nginx-config
nginx -s reload
```

## Useful Commands

```shell
webdev doctor
webdev list
webdev dev <site|--all>
webdev package <site|--all>
webdev test <site|--all>
webdev nginx-config
webdev serve
```

For throwaway local TLS testing without mounted certificates:

```shell
WEBDEV_ALLOW_SELF_SIGNED=1 webdev nginx-config
```

Use your provided certificates for normal development domains.
