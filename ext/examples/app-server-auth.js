const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

function loadAuthInfo() {
  const authPath = process.env.CODEX_AUTH_PATH || path.join(os.homedir(), '.codex', 'auth.json');
  if (!fs.existsSync(authPath)) {
    return null;
  }

  let authData;
  try {
    authData = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  } catch {
    return null;
  }

  const accessToken = authData?.tokens?.access_token;
  if (typeof accessToken !== 'string' || !accessToken.trim()) {
    return null;
  }

  const idTokenPayload = decodeJwtPayload(authData?.tokens?.id_token);
  const authClaims = idTokenPayload?.['https://api.openai.com/auth'] || {};
  const chatgptAccountId =
    authData?.tokens?.account_id
    || authClaims.chatgpt_account_id
    || authClaims.chatgpt_workspace_id
    || authClaims.org_id;

  if (typeof chatgptAccountId !== 'string' || !chatgptAccountId.trim()) {
    return null;
  }

  const chatgptPlanType =
    authClaims.chatgpt_plan_type ??
    authClaims.plan_type ??
    authData?.tokens?.chatgpt_plan_type;

  return {
    accessToken,
    chatgptAccountId,
    chatgptPlanType: typeof chatgptPlanType === 'string' ? chatgptPlanType : null,
    authPath,
  };
}

function deriveProxyToken(authInfo) {
  if (!authInfo) {
    return '';
  }

  return crypto
    .createHash('sha256')
    .update(`${authInfo.chatgptAccountId}:${authInfo.accessToken}`, 'utf8')
    .digest('hex');
}

function resolveProxyToken(authInfo) {
  const explicit = process.env.APP_SERVER_PROXY_TOKEN;
  if (typeof explicit === 'string') {
    return explicit;
  }

  return deriveProxyToken(authInfo);
}

function buildExternalAuthLoginParams(authInfo) {
  if (!authInfo) {
    return null;
  }

  return {
    type: 'chatgptAuthTokens',
    accessToken: authInfo.accessToken,
    chatgptAccountId: authInfo.chatgptAccountId,
    chatgptPlanType: authInfo.chatgptPlanType,
  };
}

function decodeJwtPayload(token) {
  if (typeof token !== 'string') {
    return null;
  }

  const parts = token.split('.');
  if (parts.length < 2) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

module.exports = {
  buildExternalAuthLoginParams,
  loadAuthInfo,
  resolveProxyToken,
};
