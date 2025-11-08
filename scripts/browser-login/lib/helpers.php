<?php

declare(strict_types=1);

namespace CodexBrowserLogin;

use DateTimeImmutable;
use DateTimeZone;
use RuntimeException;

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const ISSUER = 'https://auth.openai.com';
const ORIGINATOR = 'codex_cli_rs';
const AUTH_SCOPE = 'openid profile email offline_access';
const DEFAULT_REDIRECT_PATH = 'callback.php';
const CURL_TIMEOUT = 15;

/**
 * Ensure the PHP session is active.
 */
function ensure_session(): void
{
    if (session_status() !== PHP_SESSION_ACTIVE) {
        session_start([
            'cookie_httponly' => true,
            'cookie_secure' => !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off',
            'cookie_samesite' => 'Lax',
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
    return base64url_encode(random_bytes(32));
}

/**
 * Return the absolute URL for the callback endpoint hosted by this script.
 */
function compute_redirect_uri(): string
{
    return absolute_url(DEFAULT_REDIRECT_PATH);
}

/**
 * Build the authorization URL mirroring the CLI defaults.
 */
function build_authorize_url(array $pkce, string $state, ?string $allowedWorkspaceId = null): string
{
    $query = [
        'response_type' => 'code',
        'client_id' => CLIENT_ID,
        'redirect_uri' => compute_redirect_uri(),
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

    return ISSUER . '/oauth/authorize?' . http_build_query($query, '', '&', PHP_QUERY_RFC3986);
}

/**
 * Exchange the authorization code for tokens.
 *
 * @return array{id_token: string, access_token: string, refresh_token: string}
 */
function exchange_code_for_tokens(string $code, array $pkce): array
{
    $payload = http_build_query([
        'grant_type' => 'authorization_code',
        'code' => $code,
        'redirect_uri' => compute_redirect_uri(),
        'client_id' => CLIENT_ID,
        'code_verifier' => $pkce['code_verifier'],
    ], '', '&', PHP_QUERY_RFC3986);

    $response = post_form(ISSUER . '/oauth/token', $payload);

    $data = json_decode($response, true);
    if (!is_array($data) || !isset($data['id_token'], $data['access_token'], $data['refresh_token'])) {
        throw new RuntimeException('Token response was missing expected fields.');
    }

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

    try {
        $response = post_form(ISSUER . '/oauth/token', $payload);
    } catch (RuntimeException $e) {
        return null;
    }

    $data = json_decode($response, true);
    if (!is_array($data) || empty($data['access_token'])) {
        return null;
    }

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

    return [
        'OPENAI_API_KEY' => $apiKey,
        'tokens' => [
            'id_token' => $tokens['id_token'],
            'access_token' => $tokens['access_token'],
            'refresh_token' => $tokens['refresh_token'],
            'account_id' => $accountId,
        ],
        'last_refresh' => (new DateTimeImmutable('now', new DateTimeZone('UTC')))->format('Y-m-d\TH:i:s.u\Z'),
    ];
}

/**
 * Verify whether the returned token is allowed for the forced workspace.
 *
 * @return string|null Returns an error message when the workspace is not allowed.
 */
function ensure_workspace_allowed(?string $expectedWorkspace, ?array $idTokenClaims): ?string
{
    if ($expectedWorkspace === null || $expectedWorkspace === '') {
        return null;
    }

    if ($idTokenClaims === null) {
        return 'Login is restricted to a specific workspace, but the ID token could not be parsed.';
    }

    $actual = $idTokenClaims['chatgpt_account_id'] ?? null;
    if ($actual === null) {
        return 'Login is restricted to a specific workspace, but the token did not include a chatgpt_account_id claim.';
    }

    if ($actual !== $expectedWorkspace) {
        return 'Login is restricted to workspace id ' . htmlspecialchars($expectedWorkspace, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') . '.';
    }

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

    return [
        'needs_setup' => $needsSetup,
        'platform_url' => ISSUER === 'https://auth.openai.com'
            ? 'https://platform.openai.com'
            : 'https://platform.api.openai.org',
        'org_id' => (string)($idClaims['organization_id'] ?? ''),
        'project_id' => (string)($idClaims['project_id'] ?? ''),
        'plan_type' => (string)($accessClaims['chatgpt_plan_type'] ?? ''),
    ];
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
function post_form(string $url, string $payload): string
{
    $ch = curl_init($url);
    if ($ch === false) {
        throw new RuntimeException('Unable to initialize HTTP client.');
    }

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
        throw new RuntimeException('HTTP request failed: ' . $error);
    }

    $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);

    if ($status < 200 || $status >= 300) {
        throw new RuntimeException('HTTP request returned status ' . $status . '. Body: ' . $response);
    }

    return $response;
}

/**
 * Build an absolute URL rooted at the directory hosting the script bundle.
 */
function absolute_url(string $path): string
{
    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $host = $_SERVER['HTTP_HOST'] ?? 'localhost';
    $dir = str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? ''));
    if ($dir === '/' || $dir === '.') {
        $dir = '';
    }
    $dir = rtrim($dir, '/');

    $base = $scheme . '://' . $host;
    if ($dir !== '') {
        $base .= '/' . ltrim($dir, '/');
    }

    return rtrim($base, '/') . '/' . ltrim($path, '/');
}
