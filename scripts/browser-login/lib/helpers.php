<?php

declare(strict_types=1);

namespace CodexBrowserLogin;

use DateTimeImmutable;
use DateTimeInterface;
use DateTimeZone;
use RuntimeException;

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const ISSUER = 'https://auth.openai.com';
const ORIGINATOR = 'codex_cli_rs';
const AUTH_SCOPE = 'openid profile email offline_access';
const DEFAULT_REDIRECT_PATH = 'callback.php';
const CURL_TIMEOUT = 15;
const SESSION_LOG_KEY = '_codex_browser_login_debug';
const MAX_DEBUG_LOG_ENTRIES = 200;

/**
 * Emit a structured log line to the PHP error log.
 *
 * @param array<string, mixed> $context
 */
function log_debug(string $message, array $context = []): void
{
    $timestamp = (new DateTimeImmutable('now', new DateTimeZone('UTC')))->format('Y-m-d\TH:i:s.u\Z');
    $payload = [
        'ts' => $timestamp,
        'message' => $message,
    ];

    if ($context !== []) {
        $payload['context'] = sanitize_for_log($context);
    }

    append_debug_log($payload);

    $json = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    if ($json === false) {
        $fallback = $timestamp . ' ' . $message;
        error_log('[CodexBrowserLogin] ' . $fallback);
        return;
    }

    error_log('[CodexBrowserLogin] ' . $json);
}

/**
 * Sanitize potentially nested context values for logging.
 *
 * @param mixed $value
 * @return mixed
 */
function sanitize_for_log($value)
{
    if (is_array($value)) {
        $result = [];
        foreach ($value as $key => $item) {
            $result[$key] = sanitize_for_log($item);
        }

        return $result;
    }

    if ($value instanceof DateTimeInterface) {
        return $value->format('Y-m-d\TH:i:s.u\Z');
    }

    if (is_string($value)) {
        $clean = preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/', '', $value);
        if ($clean === null) {
            $clean = $value;
        }

        if (strlen($clean) > 1024) {
            return substr($clean, 0, 1024) . '…';
        }

        return $clean;
    }

    if (is_scalar($value) || $value === null) {
        return $value;
    }

    return gettype($value);
}

/**
 * Append a log entry to the session-scoped debug buffer.
 *
 * @param array<string, mixed> $entry
 */
function append_debug_log(array $entry): void
{
    if (session_status() !== PHP_SESSION_ACTIVE) {
        return;
    }

    if (!isset($_SESSION[SESSION_LOG_KEY]) || !is_array($_SESSION[SESSION_LOG_KEY])) {
        $_SESSION[SESSION_LOG_KEY] = [];
    }

    $_SESSION[SESSION_LOG_KEY][] = $entry;

    $count = count($_SESSION[SESSION_LOG_KEY]);
    if ($count > MAX_DEBUG_LOG_ENTRIES) {
        $_SESSION[SESSION_LOG_KEY] = array_slice($_SESSION[SESSION_LOG_KEY], $count - MAX_DEBUG_LOG_ENTRIES);
    }
}

/**
 * Return the collected session debug log entries.
 *
 * @return array<int, array<string, mixed>>
 */
function session_debug_log(): array
{
    if (session_status() !== PHP_SESSION_ACTIVE) {
        return [];
    }

    $entries = $_SESSION[SESSION_LOG_KEY] ?? [];
    return is_array($entries) ? $entries : [];
}

/**
 * Format a debug entry for display.
 */
function format_log_entry(array $entry): string
{
    $json = json_encode($entry, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    if ($json !== false) {
        return $json;
    }

    return print_r($entry, true);
}

/**
 * Clear the session debug log and destroy the session.
 */
function reset_session(): void
{
    if (session_status() !== PHP_SESSION_ACTIVE) {
        return;
    }

    unset($_SESSION[SESSION_LOG_KEY]);
    $_SESSION = [];
    session_destroy();
}

/**
 * Return a hash-based summary suitable for logging secrets.
 */
function summarize_secret(string $value): array
{
    return [
        'length' => strlen($value),
        'sha256_prefix' => substr(hash('sha256', $value), 0, 16),
    ];
}

/**
 * Build a log-friendly description of the authorize URL.
 */
function describe_authorize_url(string $url): array
{
    $parts = parse_url($url);
    $base = '';
    if ($parts !== false) {
        $scheme = isset($parts['scheme']) ? $parts['scheme'] . '://' : '';
        $host = $parts['host'] ?? '';
        $port = isset($parts['port']) ? ':' . $parts['port'] : '';
        $path = $parts['path'] ?? '';
        $base = $scheme . $host . $port . $path;
    }

    $query = [];
    if ($parts !== false && isset($parts['query'])) {
        parse_str($parts['query'], $query);
    }

    foreach (['code_challenge', 'state'] as $sensitiveKey) {
        if (isset($query[$sensitiveKey]) && is_string($query[$sensitiveKey])) {
            $query[$sensitiveKey] = summarize_secret($query[$sensitiveKey]);
        }
    }

    return [
        'base' => $base,
        'query' => $query,
    ];
}

/**
 * Ensure the PHP session is active.
 */
function ensure_session(): void
{
    if (session_status() !== PHP_SESSION_ACTIVE) {
        session_start([
            'cookie_httponly' => true,
            'cookie_secure' => determine_request_scheme() === 'https',
            'cookie_samesite' => 'Lax',
        ]);
        log_debug('Session started', [
            'session_id' => session_id(),
        ]);
    } else {
        log_debug('Session already active', [
            'session_id' => session_id(),
        ]);
    }
}

/**
 * Generate PKCE verifier/challenge pair using the same entropy as the CLI.
 *
 * @return array{code_verifier: string, code_challenge: string}
 */
function generate_pkce(): array
{
    $verifier = base64url_encode(random_bytes(64));
    $challenge = base64url_encode(hash('sha256', $verifier, true));

    log_debug('Generated PKCE pair', [
        'verifier' => summarize_secret($verifier),
        'challenge' => summarize_secret($challenge),
    ]);

    return [
        'code_verifier' => $verifier,
        'code_challenge' => $challenge,
    ];
}

/**
 * Generate the random state parameter used to guard the OAuth redirect.
 */
function generate_state(): string
{
    $state = base64url_encode(random_bytes(32));
    log_debug('Generated state token', [
        'state' => summarize_secret($state),
    ]);

    return $state;
}

/**
 * Return the absolute URL for the callback endpoint hosted by this script.
 */
function compute_redirect_uri(): string
{
    $uri = absolute_url(DEFAULT_REDIRECT_PATH);
    log_debug('Computed redirect URI', [
        'redirect_uri' => $uri,
    ]);

    return $uri;
}

/**
 * Build the authorization URL mirroring the CLI defaults.
 */
function build_authorize_url(
    array $pkce,
    string $state,
    string $redirectUri,
    ?string $allowedWorkspaceId = null
): string
{
    $query = [
        'response_type' => 'code',
        'client_id' => CLIENT_ID,
        'redirect_uri' => $redirectUri,
        'scope' => AUTH_SCOPE,
        'code_challenge' => $pkce['code_challenge'],
        'code_challenge_method' => 'S256',
        'id_token_add_organizations' => 'true',
        'codex_cli_simplified_flow' => 'true',
        'state' => $state,
        'originator' => ORIGINATOR,
    ];

    if ($allowedWorkspaceId !== null && $allowedWorkspaceId !== '') {
        $query['allowed_workspace_id'] = $allowedWorkspaceId;
    }

    $url = ISSUER . '/oauth/authorize?' . http_build_query($query, '', '&', PHP_QUERY_RFC3986);
    log_debug('Built authorize URL', describe_authorize_url($url));

    return $url;
}

/**
 * Exchange the authorization code for tokens.
 *
 * @return array{id_token: string, access_token: string, refresh_token: string}
 */
function exchange_code_for_tokens(string $code, array $pkce, string $redirectUri): array
{
    $payload = http_build_query([
        'grant_type' => 'authorization_code',
        'code' => $code,
        'redirect_uri' => $redirectUri,
        'client_id' => CLIENT_ID,
        'code_verifier' => $pkce['code_verifier'],
    ], '', '&', PHP_QUERY_RFC3986);

    log_debug('Initiating token exchange', [
        'code' => summarize_secret($code),
        'redirect_uri' => $redirectUri,
    ]);

    $response = post_form(ISSUER . '/oauth/token', $payload, [
        'operation' => 'exchange_code_for_tokens',
        'payload' => [
            'grant_type' => 'authorization_code',
            'client_id' => CLIENT_ID,
            'redirect_uri' => $redirectUri,
            'code' => summarize_secret($code),
            'code_verifier' => summarize_secret($pkce['code_verifier']),
        ],
    ]);

    $data = json_decode($response, true);
    if (!is_array($data) || !isset($data['id_token'], $data['access_token'], $data['refresh_token'])) {
        throw new RuntimeException('Token response was missing expected fields.');
    }

    log_debug('Token exchange succeeded', [
        'id_token' => summarize_secret($data['id_token']),
        'access_token' => summarize_secret($data['access_token']),
        'refresh_token' => summarize_secret($data['refresh_token']),
    ]);

    return [
        'id_token' => $data['id_token'],
        'access_token' => $data['access_token'],
        'refresh_token' => $data['refresh_token'],
    ];
}

/**
 * Request an API key via token exchange. Returns null if the exchange fails.
 */
function obtain_api_key(string $idToken): ?string
{
    $payload = http_build_query([
        'grant_type' => 'urn:ietf:params:oauth:grant-type:token-exchange',
        'client_id' => CLIENT_ID,
        'requested_token' => 'openai-api-key',
        'subject_token' => $idToken,
        'subject_token_type' => 'urn:ietf:params:oauth:token-type:id_token',
    ], '', '&', PHP_QUERY_RFC3986);

    log_debug('Attempting API key exchange', [
        'id_token' => summarize_secret($idToken),
    ]);

    try {
        $response = post_form(ISSUER . '/oauth/token', $payload, [
            'operation' => 'obtain_api_key',
        ]);
    } catch (RuntimeException $e) {
        log_debug('API key exchange failed with transport error', [
            'error' => $e->getMessage(),
        ]);
        return null;
    }

    $data = json_decode($response, true);
    if (!is_array($data) || empty($data['access_token'])) {
        log_debug('API key exchange returned unexpected payload', [
            'payload' => $data,
        ]);
        return null;
    }

    log_debug('API key exchange succeeded', [
        'api_key' => summarize_secret($data['access_token']),
    ]);

    return $data['access_token'];
}

/**
 * Compute the JSON payload that would be written to auth.json.
 */
function build_auth_json(array $tokens, ?string $apiKey): array
{
    $claims = extract_auth_claims($tokens['id_token']);
    if ($claims === null) {
        throw new RuntimeException('ID token was not a valid JWT.');
    }

    $accountId = $claims['chatgpt_account_id'] ?? null;

    $result = [
        'OPENAI_API_KEY' => $apiKey,
        'tokens' => [
            'id_token' => $tokens['id_token'],
            'access_token' => $tokens['access_token'],
            'refresh_token' => $tokens['refresh_token'],
            'account_id' => $accountId,
        ],
        'last_refresh' => (new DateTimeImmutable('now', new DateTimeZone('UTC')))->format('Y-m-d\TH:i:s.u\Z'),
    ];

    log_debug('Prepared auth.json payload', [
        'has_api_key' => $apiKey !== null,
        'account_id' => $accountId,
    ]);

    return $result;
}

/**
 * Verify whether the returned token is allowed for the forced workspace.
 *
 * @return string|null Returns an error message when the workspace is not allowed.
 */
function ensure_workspace_allowed(?string $expectedWorkspace, ?array $idTokenClaims): ?string
{
    if ($expectedWorkspace === null || $expectedWorkspace === '') {
        log_debug('Workspace check skipped', ['reason' => 'no expected workspace']);
        return null;
    }

    if ($idTokenClaims === null) {
        log_debug('Workspace check failed', ['reason' => 'missing ID token claims']);
        return 'Login is restricted to a specific workspace, but the ID token could not be parsed.';
    }

    $actual = $idTokenClaims['chatgpt_account_id'] ?? null;
    if ($actual === null) {
        log_debug('Workspace check failed', ['reason' => 'missing chatgpt_account_id']);
        return 'Login is restricted to a specific workspace, but the token did not include a chatgpt_account_id claim.';
    }

    if ($actual !== $expectedWorkspace) {
        log_debug('Workspace check failed', [
            'reason' => 'mismatch',
            'expected' => $expectedWorkspace,
            'actual' => $actual,
        ]);
        return 'Login is restricted to workspace id ' . htmlspecialchars($expectedWorkspace, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') . '.';
    }

    log_debug('Workspace check passed', [
        'workspace_id' => $expectedWorkspace,
    ]);

    return null;
}

/**
 * Extract the OpenAI-specific claim object embedded in the JWT.
 *
 * @return array<string, mixed>|null
 */
function extract_auth_claims(string $jwt): ?array
{
    $payload = decode_jwt_payload($jwt);
    if (!is_array($payload)) {
        return null;
    }

    $auth = $payload['https://api.openai.com/auth'] ?? [];
    return is_array($auth) ? $auth : [];
}

/**
 * Decode the JSON payload of a JWT as an associative array.
 *
 * @return array<string, mixed>|null
 */
function decode_jwt_payload(string $jwt): ?array
{
    $parts = explode('.', $jwt);
    if (count($parts) < 2) {
        return null;
    }

    $payload = $parts[1];
    $decoded = base64_decode(strtr($payload, '-_', '+/'), true);
    if ($decoded === false) {
        return null;
    }

    $json = json_decode($decoded, true);
    return is_array($json) ? $json : null;
}

/**
 * Build the data needed to render the success experience that the CLI provides.
 *
 * @return array{needs_setup: bool, platform_url: string, org_id: string, project_id: string, plan_type: string}
 */
function compose_success_data(array $tokens): array
{
    $idClaims = extract_auth_claims($tokens['id_token']) ?? [];
    $accessClaims = extract_auth_claims($tokens['access_token']) ?? [];

    $completedOnboarding = (bool)($idClaims['completed_platform_onboarding'] ?? false);
    $isOrgOwner = (bool)($idClaims['is_org_owner'] ?? false);
    $needsSetup = !$completedOnboarding && $isOrgOwner;

    $result = [
        'needs_setup' => $needsSetup,
        'platform_url' => ISSUER === 'https://auth.openai.com'
            ? 'https://platform.openai.com'
            : 'https://platform.api.openai.org',
        'org_id' => (string)($idClaims['organization_id'] ?? ''),
        'project_id' => (string)($idClaims['project_id'] ?? ''),
        'plan_type' => (string)($accessClaims['chatgpt_plan_type'] ?? ''),
    ];

    log_debug('Composed success metadata', $result);

    return $result;
}

/**
 * Convert binary data to URL-safe base64 without padding.
 */
function base64url_encode(string $binary): string
{
    return rtrim(strtr(base64_encode($binary), '+/', '-_'), '=');
}

/**
 * Perform an HTTP form POST and return the body when the response is successful.
 *
 * @throws RuntimeException when the request fails.
 */
function post_form(string $url, string $payload, array $logContext = []): string
{
    $ch = curl_init($url);
    if ($ch === false) {
        throw new RuntimeException('Unable to initialize HTTP client.');
    }

    log_debug('Issuing POST request', array_merge([
        'url' => $url,
        'payload_length' => strlen($payload),
    ], $logContext));

    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => $payload,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HEADER => false,
        CURLOPT_TIMEOUT => CURL_TIMEOUT,
        CURLOPT_HTTPHEADER => ['Content-Type: application/x-www-form-urlencoded'],
    ]);

    $response = curl_exec($ch);
    if ($response === false) {
        $error = curl_error($ch);
        curl_close($ch);
        log_debug('POST request failed', [
            'url' => $url,
            'error' => $error,
        ]);
        throw new RuntimeException('HTTP request failed: ' . $error);
    }

    $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);

    if ($status < 200 || $status >= 300) {
        log_debug('POST request returned non-success status', [
            'url' => $url,
            'status' => $status,
            'body' => $response,
        ]);
        throw new RuntimeException('HTTP request returned status ' . $status . '. Body: ' . $response);
    }

    log_debug('POST request succeeded', [
        'url' => $url,
        'status' => $status,
    ]);

    return $response;
}

/**
 * Build an absolute URL rooted at the directory hosting the script bundle.
 */
function absolute_url(string $path): string
{
    $scheme = determine_request_scheme();
    $host = determine_request_host($scheme);
    $dir = str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? ''));
    if ($dir === '/' || $dir === '.') {
        $dir = '';
    }
    $dir = rtrim($dir, '/');

    $base = $scheme . '://' . $host;
    $prefix = forwarded_header_value('HTTP_X_FORWARDED_PREFIX');
    if ($prefix !== null) {
        $normalizedPrefix = '/' . trim($prefix, '/');
        $base .= rtrim($normalizedPrefix, '/');
    }

    if ($dir !== '') {
        $base .= '/' . ltrim($dir, '/');
    }

    $absolute = rtrim($base, '/') . '/' . ltrim($path, '/');
    log_debug('Computed absolute URL', [
        'path' => $path,
        'absolute' => $absolute,
        'scheme' => $scheme,
        'host' => $host,
        'dir' => $dir,
        'prefix' => $prefix,
    ]);

    return $absolute;
}

/**
 * Return the first entry from a forwarded header value if present.
 */
function forwarded_header_value(string $key): ?string
{
    if (!isset($_SERVER[$key])) {
        return null;
    }

    $raw = trim((string)$_SERVER[$key]);
    if ($raw === '') {
        return null;
    }

    $parts = explode(',', $raw);
    $value = trim($parts[0]);

    $sanitized = $value === '' ? null : str_replace(["\r", "\n"], '', $value);
    log_debug('Read forwarded header', [
        'header' => $key,
        'value' => $sanitized,
    ]);

    return $sanitized;
}

/**
 * Decide whether the current request arrived via HTTP or HTTPS.
 */
function determine_request_scheme(): string
{
    $forwardedProto = forwarded_header_value('HTTP_X_FORWARDED_PROTO');
    if ($forwardedProto !== null) {
        $proto = strtolower($forwardedProto);
        if ($proto === 'https' || $proto === 'http') {
            log_debug('Determined scheme from forwarded proto', [
                'scheme' => $proto,
            ]);
            return $proto;
        }
    }

    if (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') {
        log_debug('Determined scheme from HTTPS server var', [
            'scheme' => 'https',
        ]);
        return 'https';
    }

    log_debug('Falling back to http scheme');

    return 'http';
}

/**
 * Determine the host (and optional port) that should appear in absolute URLs.
 */
function determine_request_host(string $scheme): string
{
    $hostHeader = forwarded_header_value('HTTP_X_FORWARDED_HOST') ?? ($_SERVER['HTTP_HOST'] ?? '');
    $hostHeader = trim((string)$hostHeader);
    if ($hostHeader === '') {
        $hostHeader = 'localhost';
    }

    [$host, $port] = parse_host_and_port($hostHeader);

    if ($port === null) {
        $forwardedPort = forwarded_header_value('HTTP_X_FORWARDED_PORT');
        if ($forwardedPort !== null && ctype_digit($forwardedPort)) {
            $port = (int)$forwardedPort;
        } elseif (isset($_SERVER['SERVER_PORT']) && ctype_digit((string)$_SERVER['SERVER_PORT'])) {
            $port = (int)$_SERVER['SERVER_PORT'];
        }
    }

    $defaultPort = $scheme === 'https' ? 443 : 80;
    if ($port === $defaultPort) {
        $port = null;
    }

    $host = sanitize_host($host);

    $result = $port !== null ? $host . ':' . $port : $host;
    log_debug('Determined request host', [
        'scheme' => $scheme,
        'host_header' => $hostHeader,
        'result' => $result,
        'port' => $port,
    ]);

    return $result;
}

/**
 * Parse a host header into host and port components.
 *
 * @return array{0: string, 1: int|null}
 */
function parse_host_and_port(string $header): array
{
    $header = str_replace(["\r", "\n"], '', trim($header));
    if ($header === '') {
        return ['localhost', null];
    }

    $parsed = @parse_url('scheme://' . $header);
    if ($parsed === false) {
        return [$header, null];
    }

    $host = isset($parsed['host']) ? (string)$parsed['host'] : $header;
    $port = isset($parsed['port']) ? (int)$parsed['port'] : null;

    $result = [$host, $port];
    log_debug('Parsed host header', [
        'input' => $header,
        'output' => $result,
    ]);

    return $result;
}

/**
 * Remove dangerous characters and fall back to localhost when necessary.
 */
function sanitize_host(string $host): string
{
    $host = str_replace(["\r", "\n"], '', trim($host));
    if ($host === '') {
        return 'localhost';
    }

    return $host;
}
