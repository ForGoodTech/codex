# Codex browser-only login helper

This PHP bundle reproduces the `codex login` ChatGPT flow without launching the
CLI’s localhost server. The script drives OAuth entirely inside the browser and
exposes the `auth.json` payload so it can be copied or downloaded manually.

## Files

- `index.php` – entry point that seeds a PKCE verifier/state pair and redirects
  the browser to ChatGPT’s authorize endpoint while offering a manual fallback
  button.
- `callback.php` – handles the OAuth redirect, exchanges the authorization code
  for tokens, performs the API-key token exchange, and renders the browser-based
  success page with the serialized `auth.json` data.
- `lib/helpers.php` – shared helpers that mirror the CLI defaults (client ID,
  issuer, PKCE generation, JSON formatting, and success-page metadata).

## Deploying

1. Copy the entire `scripts/browser-login` directory to an HTTPS-enabled web
   server capable of running PHP 8.1+.
2. Ensure the directory is accessible at a stable URL, for example:
   `https://example.com/browser-login/`.
3. Visit `index.php` in a browser. The script auto-redirects to
   `https://auth.openai.com/oauth/authorize` with the same parameters used by the
   CLI. If browser pop-up protection blocks the redirect, click the provided
   **Open login** button.
4. Complete the ChatGPT authorization. After the redirect returns to
   `callback.php`, the page shows a success banner along with the serialized
   `auth.json` payload.
5. Copy the payload or download it as `auth.json` and place it under
   `$CODEX_HOME/auth.json` on the machine that will run the CLI.

## Workspace restrictions

To restrict the login to a particular workspace (matching the CLI’s
`--allowed-workspace-id` guard), append
`?allowed_workspace_id=ws-123` to the `index.php` URL before starting the flow.

## Security notes

- The script stores PKCE and state information only in the user’s PHP session
  and clears it once the flow finishes.
- The success page never writes to disk; all sensitive values remain in-memory
  until the browser displays them to the user.
- The generated JSON matches the structure produced by the CLI’s
  `persist_tokens_async` path, so you can drop it directly into `auth.json`.

> **Next steps:** the **Transmit to Codex** button is a placeholder for a future
> out-of-band delivery channel back to the CLI.
