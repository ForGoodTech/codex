const BAR_SEGMENTS = 20;
const BAR_FILLED = '█';
const BAR_EMPTY = '░';
const LABEL_WIDTH = 17;

function toDisplayString(value, fallback = '(unknown)') {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (typeof value === 'string') {
    return value || fallback;
  }
  return String(value);
}

function formatBar(percentRemaining) {
  const bounded = Math.min(Math.max(percentRemaining, 0), 100);
  const filled = Math.round((bounded / 100) * BAR_SEGMENTS);
  const empty = Math.max(BAR_SEGMENTS - filled, 0);
  return `[${BAR_FILLED.repeat(filled)}${BAR_EMPTY.repeat(empty)}]`;
}

function labelLine(label, value) {
  return `${label.padEnd(LABEL_WIDTH, ' ')} ${value}`;
}

function formatPlan(planType) {
  if (!planType) return 'unknown plan';
  return planType === 'plus' ? 'Plus' : planType.charAt(0).toUpperCase() + planType.slice(1);
}

function describeAccount(accountResponse, userInfo) {
  const account = accountResponse?.account;
  if (account?.type === 'chatgpt') {
    const plan = formatPlan(account.planType);
    return `${account.email} (${plan})`;
  }
  if (account?.type === 'apiKey') {
    return 'API key (no ChatGPT login)';
  }
  const alleged = userInfo?.allegedUserEmail;
  if (alleged) {
    return `${alleged} (alleged)`;
  }
  return '(not logged in)';
}

function describeApproval(approvalPolicy) {
  switch (approvalPolicy) {
    case 'untrusted':
      return 'always ask (untrusted)';
    case 'on-failure':
      return 'on failure';
    case 'on-request':
      return 'on-request';
    case 'never':
      return 'never';
    default:
      return 'unspecified (server default)';
  }
}

function describeSandbox(mode) {
  switch (mode) {
    case 'read-only':
      return 'sandboxed (read-only)';
    case 'workspace-write':
      return 'sandboxed (workspace-write)';
    case 'danger-full-access':
      return 'danger-full-access';
    default:
      return '(default sandbox)';
  }
}

function formatResetsAt(resetsAt) {
  if (!resetsAt) return null;
  const seconds = Number(resetsAt);
  if (Number.isNaN(seconds)) return null;
  const date = new Date(seconds * 1000);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function formatDuration(minutes) {
  if (minutes === null || minutes === undefined) return null;
  const mins = Number(minutes);
  if (Number.isNaN(mins)) return null;
  if (mins % (24 * 60) === 0) {
    const days = mins / (24 * 60);
    return days >= 7 ? `${Math.round(days / 7)}w` : `${days}d`;
  }
  if (mins % 60 === 0) {
    const hours = mins / 60;
    return hours >= 24 ? `${Math.round(hours / 24)}d` : `${hours}h`;
  }
  return `${mins}m`;
}

function formatLimitRow(window) {
  if (!window) return '(not provided by protocol)';
  if (window.used_percent === null || window.used_percent === undefined) {
    return '(usage not provided by protocol)';
  }

  const remaining = 100 - window.used_percent;
  const bar = formatBar(remaining);
  const resets = formatResetsAt(window.resets_at);
  const suffix = resets ? ` (${resets})` : '';
  const leftText = `${Math.round(remaining)}% left`;
  return `${bar} ${leftText}${suffix}`;
}

function renderBox(lines) {
  const innerWidth = Math.max(...lines.map((line) => line.length));
  const horizontal = '─'.repeat(innerWidth + 2);
  const top = `╭${horizontal}╮`;
  const bottom = `╰${horizontal}╯`;
  const body = lines.map((line) => `│ ${line.padEnd(innerWidth, ' ')} │`);
  return [top, ...body, bottom].join('\n');
}

async function run({ request, connectionMode }) {
  const [userAgentResponse, authStatus, accountResponse, rateLimitsResponse, savedConfigResponse, userInfo] = await Promise.all([
    request('getUserAgent'),
    request('getAuthStatus', { includeToken: false, refreshToken: false }),
    request('account/read'),
    request('account/rateLimits/read'),
    request('getUserSavedConfig'),
    request('userInfo'),
  ]);

  const userAgent = toDisplayString(userAgentResponse?.userAgent, '(not provided)');
  const config = savedConfigResponse?.config ?? {};
  const model = config.model ?? '(default)';
  const approval = Object.prototype.hasOwnProperty.call(config, 'approvalPolicy')
    ? describeApproval(config.approvalPolicy)
    : '(not provided by protocol)';
  const sandbox = describeSandbox(config.sandboxMode);
  const authMethod = toDisplayString(authStatus?.authMethod, '(not configured)');
  const requiresOpenaiAuth = authStatus?.requiresOpenaiAuth ?? accountResponse?.requiresOpenaiAuth;
  const account = describeAccount(accountResponse, userInfo);
  const sessionId = process.env.CODEX_SESSION_ID
    ? `(client env) ${process.env.CODEX_SESSION_ID}`
    : '(not provided by protocol)';
  const connection = connectionMode === 'tcp' ? '(client) TCP proxy' : '(client) FIFOs';

  const directory = '(not provided by protocol)';
  const agentsFile = '(not provided by protocol)';

  const primaryWindow = rateLimitsResponse?.rateLimits?.primary;
  const secondaryWindow = rateLimitsResponse?.rateLimits?.secondary;
  const primaryLabel = formatDuration(primaryWindow?.window_minutes) ?? '(window not provided by protocol)';
  const secondaryLabel = formatDuration(secondaryWindow?.window_minutes) ?? '(window not provided by protocol)';
  const primaryLimit = formatLimitRow(primaryWindow);
  const secondaryLimit = formatLimitRow(secondaryWindow);

  const lines = [];
  lines.push(' >_ OpenAI Codex (example)');
  lines.push('');
  lines.push(' Visit https://chatgpt.com/codex/settings/usage for up-to-date');
  lines.push(' information on rate limits and credits');
  lines.push('');
  lines.push(labelLine('Model:', `${model}`));
  lines.push(labelLine('Directory:', directory));
  lines.push(labelLine('Approval:', approval));
  lines.push(labelLine('Sandbox:', sandbox));
  lines.push(labelLine('Agents.md:', agentsFile));
  lines.push(labelLine('Account:', account));
  lines.push(labelLine('Session:', sessionId));
  lines.push(labelLine('User agent:', userAgent));
  lines.push(labelLine('Connection:', connection));
  lines.push('');
  lines.push(labelLine('Auth method:', authMethod));
  lines.push(labelLine('Requires auth:', toDisplayString(requiresOpenaiAuth, '(unknown)')));

  lines.push('');
  if (rateLimitsResponse?.rateLimits) {
    lines.push(labelLine(`${primaryLabel} limit:`, primaryLimit));
    lines.push(labelLine(`${secondaryLabel} limit:`, secondaryLimit));
  } else {
    lines.push(labelLine('Rate limits:', '(not provided by protocol)'));
  }

  console.log(`\n/status\n\n${renderBox(lines)}\n`);
}

module.exports = { run };
