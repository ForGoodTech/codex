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

## Runtime Choices

Use Docker Compose for the normal full-stack development workflow. Compose
starts the web container and a separate MySQL container, and it is the path used
by the Hello World walkthrough below.

Use `run_web_container.sh` when you only need the web container, want quick
shell access, already have MySQL somewhere else, or want to run one-off webdev
commands without starting the Compose stack.

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
      "mode": "vite-php"
    }
  ]
}
```

Set `mode` to `vite-php` for the usual development workflow: Nginx executes
`.php` files through PHP-FPM and proxies everything else to the Vite dev server.
Set `mode` to `vite` when Nginx should proxy all HTTPS traffic to Vite. Set
`mode` to `php` when Nginx should serve the packaged PHP output from the site
root. Set `webRoot` only when packaged output lives somewhere else.

In `vite-php` mode, PHP files are executed from `root` by default. Set
`phpRoot` only when your PHP backend lives in a different directory.

By default, `webdev package` writes the packaged entry point to `index.php` in
the site root and replaces the reserved `assets/` directory with generated
frontend assets. It leaves the development `index.html` in place. Use
`webdev package-release` when you want a separate clean directory to upload.
Release packaging always includes the generated `index.php` and `assets/`, then
copies only the extra paths listed in `releaseInclude` and
`releaseOptionalInclude`.

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

## Compose Full Stack

The compose file adds a separate MySQL service and is the recommended path for
local web development:

```shell
cd ext/docker/pi-web
WEBDEV_WORKSPACE_MOUNT=/absolute/path/to/workspace docker compose up
```

MySQL data is stored in a Docker volume. Put your database initialization files
in the host directory configured by `WEBDEV_MYSQL_INIT_DIR` if you want MySQL's
official entrypoint to load them.

## Single-Container Helper

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

## Hello World Existing App Walkthrough

This walkthrough starts from an existing host directory that already contains a
simple `index.html`. It uses Compose because that is the normal full-stack path:
web server, PHP, and MySQL all run inside containers. The Pi host only needs
Docker.

Run commands from the repository root:

```shell
cd /path/to/codex
```

### 1. Set Variables

```shell
APP=/absolute/path/to/your/app
DOMAIN=app.local.test
IMAGE=my-codex-pi-web-image
```

Comment: replace `APP` with the absolute path to your app directory and replace
`DOMAIN` with your development HTTPS domain. This makes later commands
consistent and avoids accidentally mounting the wrong directory.

### 2. Stop Any Old Containers

```shell
WEBDEV_WORKSPACE_MOUNT="$APP" CODEX_WEB_IMAGE="$IMAGE" docker compose -f ext/docker/pi-web/compose.yaml down
```

Comment: this removes the running web/MySQL containers so the next start is
clean. It does not delete your app files.

### 3. Prepare The App Directory

```shell
mkdir -p "$APP/certs/dev"
```

Comment: this creates the expected certificate directory inside the mounted
workspace.

Copy your development HTTPS certs here:

```shell
cp /path/to/fullchain.pem "$APP/certs/dev/fullchain.pem"
cp /path/to/privkey.pem "$APP/certs/dev/privkey.pem"
```

Comment: Nginx inside the container will read these as
`/workspace/certs/dev/fullchain.pem` and
`/workspace/certs/dev/privkey.pem`.

### 4. Create Or Keep `index.html`

Your app entry file must be here:

```shell
ls -l "$APP/index.html"
```

If needed, create a Hello World file:

```shell
cat > "$APP/index.html" <<'EOF'
<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Hello World</title>
  </head>
  <body>
    <h1>Hello World</h1>
  </body>
</html>
EOF
```

Comment: this is the development entry point Vite will serve.

### 5. Create Minimal Vite Files

```shell
cat > "$APP/package.json" <<'EOF'
{
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build"
  },
  "devDependencies": {
    "vite": "latest"
  }
}
EOF
```

```shell
cat > "$APP/vite.config.js" <<EOF
import { defineConfig } from "vite";

export default defineConfig({
  server: {
    allowedHosts: ["$DOMAIN"],
  },
});
EOF
```

Comment: `vite.config.js` fixes Vite's blocked request error when Nginx proxies
HTTPS requests for your development domain.

### 6. Create `sites.json`

```shell
cat > "$APP/sites.json" <<EOF
{
  "defaults": {
    "cert": {
      "fullchain": "/workspace/certs/dev/fullchain.pem",
      "key": "/workspace/certs/dev/privkey.pem"
    }
  },
  "sites": [
    {
      "name": "$DOMAIN",
      "host": "$DOMAIN",
      "root": "/workspace",
      "vitePort": 5173,
      "mode": "vite-php",
      "releaseOptionalInclude": [
        "p/",
        "cots/",
        "log4php/"
      ],
      "releaseExclude": [
        "*.js",
        "*.map",
        "*.ts",
        "logs/",
        "*.sql",
        ".env",
        ".env.*"
      ]
    }
  ]
}
EOF
```

Comment: this tells the container about the site. Use `/workspace`, not the
host `/media/...` or other host filesystem path. `releaseOptionalInclude` is an
allowlist of extra backend/shared paths to copy into a production release if
they exist; `index.php` and `assets/` are always included from the packaged
output. `releaseExclude` removes source-only or local-only files from those
extra included paths.

### 7. Fix Host Permissions

```shell
chmod -R a+rX "$APP"
```

Comment: this is required because Nginx runs as `www-data` inside the
container. Without this, Nginx can see that files exist but still returns `404`
because `stat()` fails with permission denied.

### 8. Start Web And MySQL Containers

```shell
WEBDEV_WORKSPACE_MOUNT="$APP" CODEX_WEB_IMAGE="$IMAGE" WEBDEV_BIND_ADDRESS=0.0.0.0 docker compose -f ext/docker/pi-web/compose.yaml up -d mysql web
```

Comment: this starts MySQL plus Nginx/PHP-FPM. Nothing needs to be installed on
the Pi except Docker.

### 9. Generate Nginx Config

```shell
WEBDEV_WORKSPACE_MOUNT="$APP" CODEX_WEB_IMAGE="$IMAGE" docker compose -f ext/docker/pi-web/compose.yaml exec --user node web webdev nginx-config
```

```shell
WEBDEV_WORKSPACE_MOUNT="$APP" CODEX_WEB_IMAGE="$IMAGE" docker compose -f ext/docker/pi-web/compose.yaml exec web nginx -s reload
```

Comment: this makes Nginx execute `.php` files through PHP-FPM and proxy other
HTTPS traffic to Vite because the site is currently in `"mode": "vite-php"`.

### 10. Start Vite For Development

```shell
WEBDEV_WORKSPACE_MOUNT="$APP" CODEX_WEB_IMAGE="$IMAGE" docker compose -f ext/docker/pi-web/compose.yaml exec --user node web webdev dev "$DOMAIN"
```

Comment: leave this running. Development URL should now work:

```text
https://$DOMAIN/index.html
```

JavaScript in `index.html` can call PHP endpoints on the same domain, for
example `fetch("/t.php")`, and Nginx will execute those `.php` requests through
PHP-FPM.

### 11. Package To PHP

In another terminal:

```shell
WEBDEV_WORKSPACE_MOUNT="$APP" CODEX_WEB_IMAGE="$IMAGE" docker compose -f ext/docker/pi-web/compose.yaml exec --user node web webdev package "$DOMAIN"
```

Comment: this builds the Vite app in a temporary directory, leaves the
development entry point alone, and writes the packaged PHP entry point plus
generated frontend assets into the app root:

```text
$APP/index.html   # original development entry point, unchanged
$APP/index.php    # packaged entry point
$APP/assets/      # generated packaged frontend assets
```

The command does not create a packaged `index.html`. The root-level layout keeps
relative PHP paths such as `/p/...` and `/cots/...` working without copying
backend folders into a separate `dist/` directory.

### 12. Switch To PHP Mode

```shell
tmp=$(mktemp)
jq --arg host "$DOMAIN" '(.sites[] | select(.host == $host).mode) = "php"' "$APP/sites.json" > "$tmp"
mv "$tmp" "$APP/sites.json"
chmod -R a+rX "$APP"
```

Comment: this changes Nginx from "Vite frontend plus PHP backend" mode to
"serve packaged PHP from `/workspace`" mode.

### 13. Regenerate And Reload Nginx Again

```shell
WEBDEV_WORKSPACE_MOUNT="$APP" CODEX_WEB_IMAGE="$IMAGE" docker compose -f ext/docker/pi-web/compose.yaml exec --user node web webdev nginx-config
```

```shell
WEBDEV_WORKSPACE_MOUNT="$APP" CODEX_WEB_IMAGE="$IMAGE" docker compose -f ext/docker/pi-web/compose.yaml exec web nginx -s reload
```

Comment: reloading alone is not enough after changing `sites.json`; regenerate
first, then reload.

### 14. Verify Packaged PHP

```shell
WEBDEV_WORKSPACE_MOUNT="$APP" CODEX_WEB_IMAGE="$IMAGE" docker compose -f ext/docker/pi-web/compose.yaml exec web curl -k -i --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/index.php"
```

Comment: this tests the final HTTPS PHP path inside the container. Browser
should now work:

```text
https://$DOMAIN/index.php
```

`/index.html` may also load in PHP mode, but it is still the development
`index.html`; use `/index.php` when testing the packaged result.

### 15. Build A Clean Release Directory

```shell
WEBDEV_WORKSPACE_MOUNT="$APP" CODEX_WEB_IMAGE="$IMAGE" docker compose -f ext/docker/pi-web/compose.yaml exec --user node web webdev package-release "$DOMAIN"
```

Comment: this refreshes the root-level package, then writes a clean uploadable
directory from an allowlist:

```text
$APP/release/
  index.php   # always copied from packaged output
  assets/     # always copied from packaged output, if present
  p/          # copied only if listed in releaseInclude/releaseOptionalInclude
  cots/       # copied only if listed in releaseInclude/releaseOptionalInclude
  ...
```

The release command does not copy the whole app root. It always includes the
packaged `index.php` and generated `assets/`, then copies only paths listed in
`releaseInclude` and `releaseOptionalInclude`. `releaseExclude` applies to
those extra included paths, so you can exclude source file types such as
`*.js` and `*.map` from backend folders without removing bundled files
from `assets/`. Ship the contents of `$APP/release/` to the hosting provider
when you want a clean artifact.

### 16. Switch Back To Development Mode

```shell
tmp=$(mktemp)
jq --arg host "$DOMAIN" '(.sites[] | select(.host == $host).mode) = "vite-php"' "$APP/sites.json" > "$tmp"
mv "$tmp" "$APP/sites.json"
chmod -R a+rX "$APP"
```

```shell
WEBDEV_WORKSPACE_MOUNT="$APP" CODEX_WEB_IMAGE="$IMAGE" docker compose -f ext/docker/pi-web/compose.yaml exec --user node web webdev nginx-config
WEBDEV_WORKSPACE_MOUNT="$APP" CODEX_WEB_IMAGE="$IMAGE" docker compose -f ext/docker/pi-web/compose.yaml exec web nginx -s reload
```

```shell
WEBDEV_WORKSPACE_MOUNT="$APP" CODEX_WEB_IMAGE="$IMAGE" docker compose -f ext/docker/pi-web/compose.yaml exec --user node web webdev dev "$DOMAIN"
```

Comment: this switches Nginx back to the hybrid Vite frontend plus PHP backend
mode and resumes the normal development loop.

The cycle is:

```text
mode=vite-php -> develop with Vite frontend and PHP backend
webdev package -> create index.php and assets/ beside index.html
mode=php -> test /index.php locally
webdev package-release -> create release/ for upload
ship release/ -> hosting provider
mode=vite-php -> continue development
```

## Add A Website

Inside the container:

```shell
webdev init-site app.local.test
```

This creates a starter Vite app under `/workspace/sites/<host>` and adds a
`vite-php` site entry to `/workspace/sites.json`. You can pass an explicit root
and port:

```shell
webdev init-site app.local.test /workspace/sites/app 5173
```

To add your development domains, run `webdev init-site` once per domain in your
host workspace. They are not baked into the image or scripts.

## Development Modes

Hybrid Vite plus PHP development, recommended for PHP-backed apps:

```json
{
  "mode": "vite-php",
  "root": "/workspace/sites/app.local.test",
  "vitePort": 5173
}
```

In this mode, Nginx sends `.php` requests to PHP-FPM and sends everything else
to Vite. This lets `index.html` use Vite/HMR while JavaScript calls PHP
endpoints on the same HTTPS domain.

Direct Vite development, useful for frontend-only work:

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

1. Keep the site `mode` as `vite-php` in `sites.json` for PHP-backed apps, or
   `vite` for frontend-only apps.
2. Start Nginx/PHP-FPM with `webdev serve`.
3. Start Vite with `webdev dev <site>`.
4. Visit `https://<configured-domain>/`.

Nginx forwards websocket upgrade headers so Vite HMR can work through HTTPS.
In `vite-php` mode, PHP endpoints such as `/t.php` execute through PHP-FPM
instead of being served as static text.

Packaged PHP mode:

```shell
webdev package app.local.test
```

The package command runs the site's build in a temporary directory, copies the
generated output except `index.html` into the site root, then writes the built
entry point as `index.php`. Static HTML is valid PHP, so this gives a
production entry point while preserving the Vite development `index.html`.
`assets/` is reserved for packaged frontend assets and is replaced during
packaging.

Switch the site to packaged serving:

```json
{
  "host": "app.local.test",
  "root": "/workspace/sites/app.local.test",
  "mode": "php"
}
```

Set `packageDir` and `webRoot` only when you intentionally want packaged output
somewhere other than the site root.

Create a clean upload directory:

```shell
webdev package-release app.local.test
```

By default this writes `release/` under the site root. The release command is
allowlist-first: it always copies packaged `index.php` and generated `assets/`,
then copies only the extra paths listed in `releaseInclude` and
`releaseOptionalInclude`.

Use `releaseDir` to pick a different output directory. Use `releaseInclude` for
required backend/shared paths that must exist. Use `releaseOptionalInclude` for
paths that should be copied when present. Use `releaseExclude` for rsync exclude
patterns that apply only to those extra included paths, not to generated
`assets/`:

```json
{
  "host": "app.local.test",
  "root": "/workspace/sites/app.local.test",
  "mode": "php",
  "releaseDir": "release",
  "releaseInclude": [
    "p/",
    "cots/",
    "log4php/"
  ],
  "releaseOptionalInclude": [
    "vendor/"
  ],
  "releaseExclude": [
    "*.js",
    "*.map",
    "*.ts",
    "logs/",
    "*.sql",
    ".env",
    ".env.*"
  ]
}
```

With that example, `assets/app.js` from the packaged frontend is shipped, while
JavaScript source files inside `cots/` or `p/` are excluded.

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
webdev package-release <site|--all>
webdev test <site|--all>
webdev nginx-config
webdev serve
```

For throwaway local TLS testing without mounted certificates:

```shell
WEBDEV_ALLOW_SELF_SIGNED=1 webdev nginx-config
```

Use your provided certificates for normal development domains.

## Troubleshooting

If Vite returns a blocked request error, make sure `vite.config.js` includes the
configured domain:

```js
import { defineConfig } from "vite";

export default defineConfig({
  server: {
    allowedHosts: ["app.local.test"],
  },
});
```

If a PHP file displays its source code in the browser, Nginx is proxying that
request to Vite instead of PHP-FPM. Use `mode: "vite-php"` for development with
PHP endpoints, then regenerate and reload Nginx:

```shell
WEBDEV_WORKSPACE_MOUNT="$APP" CODEX_WEB_IMAGE="$IMAGE" docker compose -f ext/docker/pi-web/compose.yaml exec --user node web webdev nginx-config
WEBDEV_WORKSPACE_MOUNT="$APP" CODEX_WEB_IMAGE="$IMAGE" docker compose -f ext/docker/pi-web/compose.yaml exec web nginx -s reload
```

If Nginx returns `404` even though the file exists, check the error log:

```shell
WEBDEV_WORKSPACE_MOUNT="$APP" CODEX_WEB_IMAGE="$IMAGE" docker compose -f ext/docker/pi-web/compose.yaml exec web tail -n 50 /var/log/nginx/error.log
```

If the log says `stat() ".../index.php" failed (13: Permission denied)`, fix
host-side permissions:

```shell
chmod -R a+rX "$APP"
```

If you edit `sites.json`, regenerate the Nginx config before reloading:

```shell
WEBDEV_WORKSPACE_MOUNT="$APP" CODEX_WEB_IMAGE="$IMAGE" docker compose -f ext/docker/pi-web/compose.yaml exec --user node web webdev nginx-config
WEBDEV_WORKSPACE_MOUNT="$APP" CODEX_WEB_IMAGE="$IMAGE" docker compose -f ext/docker/pi-web/compose.yaml exec web nginx -s reload
```

For HTTPS tests inside the container, use `curl --resolve` so TLS SNI selects
the configured virtual host:

```shell
WEBDEV_WORKSPACE_MOUNT="$APP" CODEX_WEB_IMAGE="$IMAGE" docker compose -f ext/docker/pi-web/compose.yaml exec web curl -k -i --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/index.php"
```
