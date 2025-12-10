/**
 * `/status` command implementation.
 */

async function run({ request, askYesNo, connectionMode }) {
  console.log('\n/status: session and authentication status');
  console.log('Connection mode:', connectionMode === 'tcp' ? 'TCP proxy' : 'FIFOs');

  const includeToken = await askYesNo('Include auth token in output? (y/N): ');
  const refreshToken = await askYesNo('Refresh token before reading status? (y/N): ');

  const [userAgentResponse, authStatus] = await Promise.all([
    request('getUserAgent'),
    request('getAuthStatus', {
      includeToken: includeToken ? true : undefined,
      refreshToken: refreshToken ? true : undefined,
    }),
  ]);

  if (userAgentResponse?.userAgent) {
    console.log('\nServer user agent:', userAgentResponse.userAgent);
  } else {
    console.log('\nServer user agent: (not provided)');
  }

  if (!authStatus) {
    console.log('Auth status: (not provided)');
    return;
  }

  const { authMethod, authToken, requiresOpenaiAuth } = authStatus;
  console.log('Auth required for current model provider:', requiresOpenaiAuth ?? '(unknown)');
  console.log('Auth method:', authMethod ?? '(not configured)');
  if (includeToken) {
    console.log('Auth token:', authToken ?? '(none)');
  } else if (authToken) {
    console.log('Auth token present? yes (value hidden)');
  } else {
    console.log('Auth token present? no');
  }
}

module.exports = { run };
