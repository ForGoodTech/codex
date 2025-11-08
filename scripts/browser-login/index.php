<?php

declare(strict_types=1);

use function CodexBrowserLogin\build_authorize_url;
use function CodexBrowserLogin\compute_redirect_uri;
use function CodexBrowserLogin\ensure_session;
use function CodexBrowserLogin\generate_pkce;
use function CodexBrowserLogin\generate_state;

require __DIR__ . '/lib/helpers.php';

ensure_session();

if (empty($_SESSION['flow_initialized'])) {
    session_regenerate_id(true);
    $_SESSION['flow_initialized'] = true;
}

$allowedWorkspace = null;
if (isset($_GET['allowed_workspace_id'])) {
    $allowedWorkspace = is_string($_GET['allowed_workspace_id']) ? trim($_GET['allowed_workspace_id']) : null;
    if ($allowedWorkspace !== null && $allowedWorkspace !== '') {
        $_SESSION['allowed_workspace_id'] = $allowedWorkspace;
    }
}

$pkce = generate_pkce();
$state = generate_state();

$_SESSION['pkce'] = $pkce;
$_SESSION['state'] = $state;
$_SESSION['redirect_uri'] = compute_redirect_uri();

if (!isset($_SESSION['allowed_workspace_id'])) {
    $_SESSION['allowed_workspace_id'] = $allowedWorkspace;
}

$authUrl = build_authorize_url($pkce, $state, $_SESSION['allowed_workspace_id'] ?? null);

?><!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Codex Browser Login</title>
    <meta http-equiv="refresh" content="0;url=<?php echo htmlspecialchars($authUrl, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); ?>" />
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
    </div>
  </body>
</html>
