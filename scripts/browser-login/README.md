# Codex browser-only login helper

This PHP bundle reproduces the `codex login` ChatGPT flow without launching the
CLI’s localhost server. The script drives OAuth entirely inside the browser and
exposes the `auth.json` payload so it can be copied or downloaded manually.

## Files

- `index.php` – entry point that seeds a PKCE verifier/state pair and redirects
  the browser to ChatGPT’s authorize endpoint while offering a manual fallback
  button.
- `auth/callback/index.php` – handles the OAuth redirect, exchanges the authorization code
  for tokens, performs the API-key token exchange, and renders the browser-based
  success page with the serialized `auth.json` data.
- `lib/helpers.php` – shared helpers that mirror the CLI defaults (client ID,
  issuer, PKCE generation, JSON formatting, and success-page metadata).

## Deploying

1. Copy the entire `scripts/browser-login` directory to an HTTPS-enabled web
   server capable of running PHP 8.1+.
2. Ensure the directory is accessible at a stable URL, for example:
   `https://example.com/browser-login/`.
3. Visit `index.php` in a browser. The page presents the exact authorize URL
   that the CLI would open—including the `codex_cli_simplified_flow=true` flag—and
   provides an **Open login** button you can click to follow the flow manually.
4. Complete the ChatGPT authorization. After the redirect returns to
   `auth/callback/`, the page shows a success banner along with the serialized
   `auth.json` payload.
5. Copy the payload or download it as `auth.json` and place it under
   `$CODEX_HOME/auth.json` on the machine that will run the CLI.

## Workspace restrictions

To restrict the login to a particular workspace (matching the CLI’s
`--allowed-workspace-id` guard), append
`?allowed_workspace_id=ws-123` to the `index.php` URL before starting the flow.

## Reverse proxy deployments

If you serve the helper behind a load balancer or reverse proxy, make sure the
proxy forwards the standard `X-Forwarded-Proto`, `X-Forwarded-Host`, and
`X-Forwarded-Port` headers. The scripts use these headers to reconstruct the
public callback URL so the OAuth server sees the exact redirect URI that the
browser used. Set `X-Forwarded-Prefix` when the helper is published under a
path prefix (for example `/tools/browser-login`) to ensure generated links keep
that prefix intact.

## Debug logging

All entry points emit structured JSON logs to the PHP error log under the
`[CodexBrowserLogin]` prefix. Each log line includes a UTC timestamp and
redacted context—sensitive values such as PKCE verifiers, OAuth codes, and
tokens are summarized with length and SHA-256 prefixes instead of the raw
secret. Use these logs to trace the authorize redirect, callback handling, and
token exchanges when diagnosing authentication failures (for example, the
`unknown_error` page). On shared hosts, ensure the PHP error log is writable and
that only trusted administrators can read it, since the summaries still contain
metadata about the login attempt.

## Security notes

- The script stores PKCE and state information only in the user’s PHP session
  and clears it once the flow finishes.
- The success page never writes to disk; all sensitive values remain in-memory
  until the browser displays them to the user.
- The generated JSON matches the structure produced by the CLI’s
  `persist_tokens_async` path, so you can drop it directly into `auth.json`.

> **Next steps:** the **Transmit to Codex** button is a placeholder for a future
> out-of-band delivery channel back to the CLI.
