<?php

declare(strict_types=1);

use function CodexBrowserLogin\build_auth_json;
use function CodexBrowserLogin\compose_success_data;
use function CodexBrowserLogin\compute_redirect_uri;
use function CodexBrowserLogin\ensure_session;
use function CodexBrowserLogin\ensure_workspace_allowed;
use function CodexBrowserLogin\exchange_code_for_tokens;
use function CodexBrowserLogin\extract_auth_claims;
use function CodexBrowserLogin\format_log_entry;
use function CodexBrowserLogin\log_debug;
use function CodexBrowserLogin\obtain_api_key;
use function CodexBrowserLogin\reset_session;
use function CodexBrowserLogin\session_debug_log;
use function CodexBrowserLogin\summarize_secret;

require __DIR__ . '/lib/helpers.php';

ensure_session();

log_debug('Callback invoked', [
    'session_id' => session_id(),
    'query' => [
        'has_code' => isset($_GET['code']),
        'has_state' => isset($_GET['state']),
        'error' => $_GET['error'] ?? null,
        'error_description' => $_GET['error_description'] ?? null,
    ],
    'session_keys' => array_keys($_SESSION),
]);

function render_error(string $title, string $message, ?string $detail = null): void
{
    log_debug('Rendering error page', [
        'title' => $title,
        'message' => $message,
        'detail' => $detail,
    ]);
    $logEntries = session_debug_log();
    reset_session();
    http_response_code(400);
    ?><!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title><?php echo htmlspecialchars($title, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); ?></title>
    <style>
      body {
        font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        background: #f3f4f6;
      }
      .card {
        background: white;
        padding: 32px;
        border-radius: 16px;
        box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08);
        max-width: 520px;
      }
      h1 {
        margin-top: 0;
        font-size: 1.75rem;
        font-weight: 600;
        color: #111827;
      }
      p {
        color: #4b5563;
        line-height: 1.6;
      }
      code {
        background: rgba(0, 0, 0, 0.05);
        padding: 0.15rem 0.35rem;
        border-radius: 4px;
      }
      a.button {
        display: inline-flex;
        margin-top: 1.25rem;
        padding: 0.65rem 1.4rem;
        border-radius: 999px;
        background: black;
        color: white;
        text-decoration: none;
        font-weight: 600;
      }
      details.log {
        margin-top: 1.5rem;
      }
      details.log summary {
        font-weight: 600;
        cursor: pointer;
      }
      details.log pre {
        background: rgba(15, 23, 42, 0.04);
        padding: 12px;
        border-radius: 8px;
        overflow-x: auto;
        font-size: 0.85rem;
      }
    </style>
  </head>
  <body>
    <div class="card">
      <h1><?php echo htmlspecialchars($title, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); ?></h1>
      <p><?php echo nl2br(htmlspecialchars($message, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'), false); ?></p>
      <?php if ($detail !== null) : ?>
        <p><code><?php echo htmlspecialchars($detail, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); ?></code></p>
      <?php endif; ?>
      <?php if (!empty($logEntries)) : ?>
        <details class="log" open>
          <summary>Debug log</summary>
          <pre><?php foreach ($logEntries as $entry) { echo htmlspecialchars(format_log_entry($entry), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') . "\n"; } ?></pre>
        </details>
      <?php endif; ?>
      <a class="button" href="index.php">Start over</a>
    </div>
  </body>
</html>
<?php
    exit;
}

if (!isset($_SESSION['pkce'], $_SESSION['state'], $_SESSION['redirect_uri'])) {
    log_debug('Session state missing required keys', [
        'session_keys' => array_keys($_SESSION),
    ]);
    render_error('Login session expired', 'The login helper could not find an active session. Start again to generate a new OAuth request.');
}

if (isset($_GET['error'])) {
    $error = is_string($_GET['error']) ? $_GET['error'] : 'unknown_error';
    $description = isset($_GET['error_description']) && is_string($_GET['error_description'])
        ? $_GET['error_description']
        : 'The authorization server returned an error.';
    log_debug('Authorization server returned error', [
        'error' => $error,
        'description' => $description,
    ]);
    render_error('Authorization failed', $description, $error);
}

$expectedState = $_SESSION['state'];
$actualState = isset($_GET['state']) && is_string($_GET['state']) ? $_GET['state'] : null;
if ($actualState !== $expectedState) {
    log_debug('State mismatch detected', [
        'expected' => summarize_secret((string)$expectedState),
        'actual' => $actualState === null ? null : summarize_secret($actualState),
    ]);
    render_error('State mismatch', 'The OAuth response did not include the expected state token. This can happen when the browser reused an expired tab.');
}

log_debug('State token validated', [
    'state' => summarize_secret($expectedState),
]);

$authorizationCode = isset($_GET['code']) && is_string($_GET['code']) ? $_GET['code'] : null;
if ($authorizationCode === null || $authorizationCode === '') {
    render_error('Missing authorization code', 'The OAuth callback was missing the authorization code parameter.');
}

log_debug('Authorization code received', [
    'code' => summarize_secret($authorizationCode),
]);

$pkce = $_SESSION['pkce'];
$redirectUri = is_string($_SESSION['redirect_uri']) ? $_SESSION['redirect_uri'] : compute_redirect_uri();
$forcedWorkspace = $_SESSION['allowed_workspace_id'] ?? null;

log_debug('Loaded session state for callback', [
    'redirect_uri' => $redirectUri,
    'forced_workspace' => $forcedWorkspace,
]);

try {
    $tokens = exchange_code_for_tokens($authorizationCode, $pkce, $redirectUri);
} catch (Throwable $exception) {
    log_debug('Token exchange threw exception', [
        'exception' => get_class($exception),
        'message' => $exception->getMessage(),
    ]);
    render_error('Token exchange failed', 'The login helper could not exchange the authorization code for tokens.', $exception->getMessage());
}

$idClaims = extract_auth_claims($tokens['id_token']);
if ($idClaims === null) {
    log_debug('Failed to parse ID token');
    render_error('Invalid ID token', 'The returned ID token could not be parsed.');
}

if ($message = ensure_workspace_allowed($forcedWorkspace, $idClaims)) {
    render_error('Workspace restricted', $message);
}

$apiKey = obtain_api_key($tokens['id_token']);
$apiKeySummary = $apiKey === null ? null : summarize_secret($apiKey);
log_debug('API key exchange outcome', [
    'obtained' => $apiKey !== null,
    'api_key' => $apiKeySummary,
]);
$authJson = build_auth_json($tokens, $apiKey);
$authJsonString = json_encode($authJson, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
if ($authJsonString === false) {
    render_error('Serialization error', 'Unable to serialize the auth.json payload.');
}

$successData = compose_success_data($tokens);
$downloadHref = 'data:application/json;charset=utf-8,' . rawurlencode($authJsonString);

$successContext = [
    'needs_setup' => $successData['needs_setup'],
    'org_id' => $successData['org_id'],
    'project_id' => $successData['project_id'],
    'plan_type' => $successData['plan_type'],
];
log_debug('Rendering success page', $successContext);
$logEntries = session_debug_log();
reset_session();

?><!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Signed in to Codex</title>
    <style>
      :root {
        color-scheme: light;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      }
      body {
        margin: 0;
        background: white;
        display: flex;
        min-height: 100vh;
        align-items: center;
        justify-content: center;
      }
      .container {
        display: flex;
        flex-direction: column;
        gap: 24px;
        align-items: center;
        max-width: 900px;
        padding: 48px 24px 64px;
      }
      .hero {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 16px;
      }
      .logo {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 64px;
        height: 64px;
        border-radius: 20px;
        border: 1px solid rgba(0, 0, 0, 0.08);
        box-shadow: rgba(15, 23, 42, 0.08) 0px 12px 32px;
      }
      .hero h1 {
        font-size: 2rem;
        font-weight: 500;
        margin: 0;
        color: #0d0d0d;
      }
      .notice {
        font-size: 1rem;
        color: #4b5563;
        text-align: center;
      }
      .setup-card,
      .json-card {
        background: #ffffff;
        border-radius: 18px;
        border: 1px solid rgba(15, 23, 42, 0.08);
        box-shadow: 0 10px 40px rgba(15, 23, 42, 0.08);
        width: min(720px, 100%);
        padding: 24px 28px;
      }
      .setup-card {
        display: none;
        align-items: center;
        gap: 16px;
      }
      .setup-card.active {
        display: flex;
      }
      .json-card h2 {
        margin-top: 0;
        font-size: 1.25rem;
        font-weight: 600;
      }
      .json-card p {
        color: #4b5563;
        line-height: 1.5;
      }
      textarea {
        width: 100%;
        min-height: 260px;
        font-family: 'SFMono-Regular', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
        font-size: 0.95rem;
        padding: 16px;
        border-radius: 12px;
        border: 1px solid rgba(15, 23, 42, 0.12);
        background: rgba(15, 23, 42, 0.02);
        resize: vertical;
      }
      .actions {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        margin-top: 16px;
      }
      button,
      a.download {
        border: none;
        border-radius: 999px;
        background: #0d0d0d;
        color: white;
        padding: 0.65rem 1.5rem;
        font-weight: 600;
        cursor: pointer;
        text-decoration: none;
      }
      button.secondary,
      a.secondary {
        background: white;
        color: #0d0d0d;
        border: 1px solid rgba(15, 23, 42, 0.1);
      }
      .copy-success {
        color: #059669;
        font-size: 0.95rem;
        margin-top: 8px;
      }
      .close-hint {
        font-size: 1rem;
        color: #4b5563;
        margin-top: 16px;
      }
      details.log {
        width: min(720px, 100%);
        background: #ffffff;
        border-radius: 18px;
        border: 1px solid rgba(15, 23, 42, 0.08);
        box-shadow: 0 10px 40px rgba(15, 23, 42, 0.08);
        padding: 20px 24px;
      }
      details.log summary {
        font-weight: 600;
        cursor: pointer;
        outline: none;
      }
      details.log pre {
        margin-top: 16px;
        background: rgba(15, 23, 42, 0.04);
        padding: 12px;
        border-radius: 8px;
        overflow-x: auto;
        font-size: 0.85rem;
      }
    </style>
  </head>
  <body>
    <div class="container" data-needs-setup="<?php echo $successData['needs_setup'] ? 'true' : 'false'; ?>" data-platform-url="<?php echo htmlspecialchars($successData['platform_url'], ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); ?>" data-org-id="<?php echo htmlspecialchars($successData['org_id'], ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); ?>" data-project-id="<?php echo htmlspecialchars($successData['project_id'], ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); ?>" data-plan="<?php echo htmlspecialchars($successData['plan_type'], ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); ?>" data-id-token="<?php echo htmlspecialchars($tokens['id_token'], ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); ?>">
      <div class="hero">
        <div class="logo">
          <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" fill="none" viewBox="0 0 32 32"><path stroke="#000" stroke-linecap="round" stroke-width="2.484" d="M22.356 19.797H17.17M9.662 12.29l1.979 3.576a.511.511 0 0 1-.005.504l-1.974 3.409M30.758 16c0 8.15-6.607 14.758-14.758 14.758-8.15 0-14.758-6.607-14.758-14.758C1.242 7.85 7.85 1.242 16 1.242c8.15 0 14.758 6.608 14.758 14.758Z"/></svg>
        </div>
        <h1>Signed in to Codex</h1>
        <p class="notice">
          The browser has completed the ChatGPT OAuth flow without using a local helper server. Copy the payload below to finish setting up Codex.
        </p>
      </div>
      <div class="close-hint">You may now close this page when you are done.</div>
      <div class="setup-card" id="setup-card">
        <div>
          <h2 style="margin:0 0 4px 0;font-size:1.05rem;font-weight:600;">Finish setting up your API organization</h2>
          <p style="margin:0;color:#4b5563;">Add a payment method to use your organization. We will redirect you automatically.</p>
        </div>
        <div>
          <button type="button" id="redirect-button">Redirecting…</button>
        </div>
      </div>
      <div class="json-card">
        <h2>auth.json payload</h2>
        <p>Copy this JSON into the <code>auth.json</code> file under your <code>$CODEX_HOME</code> directory. No file was written on the server.</p>
        <textarea id="auth-json" readonly><?php echo htmlspecialchars($authJsonString, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); ?></textarea>
        <div class="actions">
          <button type="button" id="copy-button">Copy to clipboard</button>
          <a class="download" id="download-button" download="auth.json" href="<?php echo htmlspecialchars($downloadHref, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); ?>">Download JSON</a>
          <button type="button" class="secondary" id="transmit-button" disabled>Transmit to Codex (coming soon)</button>
        </div>
        <?php if ($apiKey === null) : ?>
          <p class="copy-success" style="color:#dc2626;">The API key exchange did not return a key. The CLI will fall back to ChatGPT tokens only.</p>
        <?php endif; ?>
        <div class="copy-success" id="copy-status" hidden>Copied to clipboard.</div>
      </div>
      <?php if (!empty($logEntries)) : ?>
        <details class="log" open>
          <summary>Debug log</summary>
          <pre><?php foreach ($logEntries as $entry) { echo htmlspecialchars(format_log_entry($entry), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') . "\n"; } ?></pre>
        </details>
      <?php endif; ?>
    </div>
    <script>
      (() => {
        const container = document.querySelector('.container');
        const needsSetup = container.dataset.needsSetup === 'true';
        const platformUrl = container.dataset.platformUrl;
        const orgId = container.dataset.orgId;
        const projectId = container.dataset.projectId;
        const plan = container.dataset.plan;
        const idToken = container.dataset.idToken;
        const setupCard = document.getElementById('setup-card');
        const redirectButton = document.getElementById('redirect-button');

        if (needsSetup) {
          setupCard.classList.add('active');
          let countdown = 3;
          const tick = () => {
            redirectButton.textContent = `Redirecting in ${countdown}s…`;
            if (countdown === 0) {
              const target = new URL('/org-setup', platformUrl);
              target.searchParams.set('p', plan);
              target.searchParams.set('t', idToken);
              if (orgId) target.searchParams.set('with_org', orgId);
              if (projectId) target.searchParams.set('project_id', projectId);
              window.location.replace(target.toString());
            } else {
              countdown -= 1;
              setTimeout(tick, 1000);
            }
          };
          tick();
        }

        const copyButton = document.getElementById('copy-button');
        const copyStatus = document.getElementById('copy-status');
        copyButton.addEventListener('click', async () => {
          const text = document.getElementById('auth-json').value;
          try {
            await navigator.clipboard.writeText(text);
            copyStatus.hidden = false;
            copyStatus.textContent = 'Copied to clipboard.';
            setTimeout(() => {
              copyStatus.hidden = true;
            }, 3000);
          } catch (err) {
            copyStatus.hidden = false;
            copyStatus.textContent = 'Unable to copy automatically. Select the text manually.';
            copyStatus.style.color = '#dc2626';
          }
        });
      })();
    </script>
  </body>
</html>
