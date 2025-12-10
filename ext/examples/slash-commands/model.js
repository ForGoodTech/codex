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

function labelLine(label, value) {
  return `${label.padEnd(LABEL_WIDTH, ' ')} ${value}`;
}

function renderBox(lines) {
  const innerWidth = Math.max(...lines.map((line) => line.length));
  const horizontal = '─'.repeat(innerWidth + 2);
  const top = `╭${horizontal}╮`;
  const bottom = `╰${horizontal}╯`;
  const body = lines.map((line) => `│ ${line.padEnd(innerWidth, ' ')} │`);
  return [top, ...body, bottom].join('\n');
}

function describeModel(modelId, models, fallback = '(server default)') {
  if (!modelId) {
    return fallback;
  }
  const found = models.find((model) => model.model === modelId);
  if (found) {
    return `${found.displayName} (${found.model})`;
  }
  return toDisplayString(modelId, fallback);
}

function formatEffortOptions(model) {
  const options = model.supportedReasoningEfforts ?? [];
  if (!options.length) {
    return '(no reasoning efforts provided)';
  }

  return options
    .map((option) => {
      const description = option.description ? ` – ${option.description}` : '';
      return `${option.reasoningEffort}${description}`;
    })
    .join('; ');
}

async function run({ request }) {
  const [savedConfigResponse, modelListResponse] = await Promise.all([
    request('getUserSavedConfig'),
    request('model/list', { cursor: null, limit: null }),
  ]);

  const models = modelListResponse?.data ?? [];
  const activeModelId = savedConfigResponse?.config?.model;
  const defaultModel = models.find((model) => model.isDefault) ?? null;

  const summaryLines = [];
  summaryLines.push(' >_ OpenAI Codex (example)');
  summaryLines.push('');
  summaryLines.push(labelLine('Active model:', describeModel(activeModelId, models)));
  summaryLines.push(
    labelLine(
      'Server default:',
      defaultModel ? `${defaultModel.displayName} (${defaultModel.model})` : '(not provided by protocol)',
    ),
  );
  summaryLines.push(labelLine('Models returned:', models.length.toString()));

  console.log(`\n/model\n\n${renderBox(summaryLines)}\n`);

  if (!models.length) {
    console.log('No models were returned by the server.');
    return;
  }

  console.log('Available models:\n');
  models.forEach((model, index) => {
    const markers = [];
    if (model.isDefault) {
      markers.push('server default');
    }
    if (model.model === activeModelId || (!activeModelId && model.isDefault)) {
      markers.push('active');
    }
    const markerText = markers.length ? ` [${markers.join(', ')}]` : '';
    const effortOptions = formatEffortOptions(model);

    console.log(`${index + 1}. ${model.displayName} (${model.model})${markerText}`);
    console.log(`   Description: ${toDisplayString(model.description, '(no description provided)')}`);
    console.log(
      `   Reasoning: default ${model.defaultReasoningEffort}; options: ${effortOptions}`,
    );
    console.log('');
  });
}

module.exports = { run };
