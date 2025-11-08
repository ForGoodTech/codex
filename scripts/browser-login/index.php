<?php

declare(strict_types=1);

use function CodexBrowserLogin\build_authorize_url;
use function CodexBrowserLogin\compute_redirect_uri;
use function CodexBrowserLogin\describe_authorize_url;
use function CodexBrowserLogin\ensure_session;
use function CodexBrowserLogin\generate_pkce;
use function CodexBrowserLogin\generate_state;
use function CodexBrowserLogin\log_debug;
use function CodexBrowserLogin\session_debug_log;
use function CodexBrowserLogin\format_log_entry;
use function CodexBrowserLogin\summarize_secret;

require __DIR__ . '/lib/helpers.php';

ensure_session();

log_debug('Index request received', [
    'session_id' => session_id(),
    'method' => $_SERVER['REQUEST_METHOD'] ?? 'GET',
    'query' => array_map(static function ($value) {
        return is_string($value) ? $value : gettype($value);
    }, $_GET),
]);

if (empty($_SESSION['flow_initialized'])) {
    session_regenerate_id(true);
    $_SESSION['flow_initialized'] = true;
    log_debug('Initialized new login session', [
        'session_id' => session_id(),
    ]);
} else {
    log_debug('Reusing login session', [
        'session_id' => session_id(),
    ]);
}

$allowedWorkspace = null;
if (isset($_GET['allowed_workspace_id'])) {
    $allowedWorkspace = is_string($_GET['allowed_workspace_id']) ? trim($_GET['allowed_workspace_id']) : null;
    if ($allowedWorkspace !== null && $allowedWorkspace !== '') {
        $_SESSION['allowed_workspace_id'] = $allowedWorkspace;
    }
}

log_debug('Processed allowed workspace parameter', [
    'allowed_workspace_query' => $allowedWorkspace,
    'session_value' => $_SESSION['allowed_workspace_id'] ?? null,
]);

$pkce = generate_pkce();
$state = generate_state();
$redirectUri = compute_redirect_uri();
$pkceSummary = [
    'code_verifier' => summarize_secret($pkce['code_verifier']),
    'code_challenge' => summarize_secret($pkce['code_challenge']),
];
$stateSummary = summarize_secret($state);

$_SESSION['pkce'] = $pkce;
$_SESSION['state'] = $state;
$_SESSION['redirect_uri'] = $redirectUri;

log_debug('Stored OAuth handshake state', [
    'session_id' => session_id(),
    'pkce' => [
        'verifier' => summarize_secret($pkce['code_verifier']),
        'challenge' => summarize_secret($pkce['code_challenge']),
    ],
    'state' => summarize_secret($state),
    'redirect_uri' => $redirectUri,
]);

if (!isset($_SESSION['allowed_workspace_id'])) {
    $_SESSION['allowed_workspace_id'] = $allowedWorkspace;
}

$authUrl = build_authorize_url(
    $pkce,
    $state,
    $redirectUri,
    $_SESSION['allowed_workspace_id'] ?? null
);

log_debug('Prepared authorize redirect', [
    'session_id' => session_id(),
    'authorize' => describe_authorize_url($authUrl),
]);

log_debug('Rendering index without automatic redirect', [
    'session_id' => session_id(),
    'auto_redirect' => false,
]);

$logEntries = session_debug_log();

?><!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Codex Browser Login</title>
    <!--
      Automatic redirect disabled to allow manual step-by-step troubleshooting of the OAuth flow.
      <meta http-equiv="refresh" content="0;url=<?php echo htmlspecialchars($authUrl, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); ?>" />
    -->
    <style>
      body {
        font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        background: #f5f5f5;
      }
      .card {
        background: white;
        padding: 32px;
        border-radius: 16px;
        box-shadow: 0 10px 40px rgba(0, 0, 0, 0.08);
        max-width: 480px;
        text-align: center;
      }
      h1 {
        font-weight: 500;
        font-size: 1.75rem;
        margin-bottom: 0.75rem;
      }
      p {
        margin: 0.5rem 0 1.5rem;
        color: #4b5563;
        line-height: 1.5;
      }
      a.button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0.75rem 1.5rem;
        border-radius: 999px;
        background: black;
        color: white;
        text-decoration: none;
        font-weight: 600;
      }
      code {
        background: rgba(0, 0, 0, 0.04);
        padding: 0.1rem 0.4rem;
        border-radius: 4px;
      }
      pre {
        text-align: left;
        background: rgba(15, 23, 42, 0.04);
        padding: 12px;
        border-radius: 8px;
        overflow-x: auto;
        font-size: 0.85rem;
      }
      details.log {
        margin-top: 24px;
        text-align: left;
      }
      details.log summary {
        cursor: pointer;
        font-weight: 600;
      }
      dl.meta {
        text-align: left;
        margin: 1.5rem 0 0;
      }
      dl.meta dt {
        font-weight: 600;
        margin-top: 0.75rem;
      }
      dl.meta dd {
        margin: 0.25rem 0 0;
        font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
        font-size: 0.85rem;
      }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Redirecting to ChatGPT…</h1>
      <p>
        Your browser is about to open the official ChatGPT OAuth page on behalf of the
        <code>codex login</code> command. If nothing happens, click the button below.
      </p>
      <a class="button" href="<?php echo htmlspecialchars($authUrl, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); ?>">Open login</a>
      <dl class="meta">
        <dt>Authorize URL</dt>
        <dd><code><?php echo htmlspecialchars($authUrl, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); ?></code></dd>
        <dt>Redirect URI</dt>
        <dd><code><?php echo htmlspecialchars($redirectUri, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); ?></code></dd>
        <dt>State summary</dt>
        <dd><code><?php echo htmlspecialchars(json_encode($stateSummary, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); ?></code></dd>
        <dt>PKCE summary</dt>
        <dd><code><?php echo htmlspecialchars(json_encode($pkceSummary, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); ?></code></dd>
      </dl>
      <?php if (!empty($logEntries)) : ?>
        <details class="log" open>
          <summary>Debug log</summary>
          <pre><?php foreach ($logEntries as $entry) { echo htmlspecialchars(format_log_entry($entry), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') . "\n"; } ?></pre>
        </details>
      <?php endif; ?>
    </div>
  </body>
</html>
