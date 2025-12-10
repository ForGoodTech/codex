const LABEL_WIDTH = 20;

function toDisplayString(value, fallback = '(not provided by protocol)') {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') return value || fallback;
  return String(value);
}

function describeModelConfig(config) {
  if (!config || !Object.prototype.hasOwnProperty.call(config, 'model')) {
    return '(not provided by protocol)';
  }

  const model = toDisplayString(config.model, '(not provided by protocol)');
  const details = [];

  if (config.modelReasoningEffort) {
    details.push(`reasoning ${config.modelReasoningEffort}`);
  }
  if (config.modelReasoningSummary) {
    details.push(`summaries ${config.modelReasoningSummary}`);
  }
  if (config.modelVerbosity) {
    details.push(`verbosity ${config.modelVerbosity}`);
  }

  return details.length ? `${model} (${details.join(', ')})` : model;
}

function labelLine(label, value) {
  return `${label.padEnd(LABEL_WIDTH, ' ')} ${value}`;
}

async function listModels(request) {
  const models = [];
  let cursor = null;

  do {
    const response = await request('model/list', { cursor, limit: null });
    if (response?.data?.length) {
      models.push(...response.data);
    }
    cursor = response?.nextCursor ?? null;
  } while (cursor);

  return models;
}

function renderModel(model, index) {
  const name = toDisplayString(model.displayName ?? model.model ?? model.id, '(model id missing)');
  const modelId = toDisplayString(model.model ?? model.id, '(model id missing)');
  const reasoning = model.supportedReasoningEfforts?.map((option) => option.reasoningEffort).join(', ');
  const defaultReasoning = model.defaultReasoningEffort ? `default reasoning ${model.defaultReasoningEffort}` : null;
  const detailParts = [];
  if (reasoning) {
    detailParts.push(`supports: ${reasoning}`);
  }
  if (defaultReasoning) {
    detailParts.push(defaultReasoning);
  }
  if (model.isDefault) {
    detailParts.push('protocol default');
  }

  const info = detailParts.length ? ` (${detailParts.join('; ')})` : '';
  const description = toDisplayString(model.description, '(no description provided)');

  const lines = [];
  lines.push(labelLine(`[${index + 1}] Model:`, `${name}${info}`));
  lines.push(labelLine('Identifier:', modelId));
  lines.push(labelLine('Description:', description));
  return lines;
}

async function run({ request, askLine }) {
  const savedConfigResponse = await request('getUserSavedConfig');
  const config = savedConfigResponse?.config ?? {};
  const currentModel = describeModelConfig(config);
  const models = await listModels(request);

  console.log('\n/model\n');
  console.log(labelLine('Current model:', currentModel));

  if (!models.length) {
    console.log('\nModel list: (not provided by protocol)');
    return;
  }

  console.log('\nAvailable models (from protocol):');
  const rendered = models.flatMap((model, index) => renderModel(model, index));
  rendered.forEach((line) => console.log(line));

  const selection = await askLine('\nEnter model number to set as default (or press Enter to keep current): ');
  if (!selection) {
    console.log('No changes made.');
    return;
  }

  const selectionIndex = Number.parseInt(selection, 10);
  if (Number.isNaN(selectionIndex) || selectionIndex < 1 || selectionIndex > models.length) {
    console.log('Invalid selection. No changes made.');
    return;
  }

  const chosen = models[selectionIndex - 1];
  const modelIdentifier = chosen.model ?? chosen.id ?? null;
  const reasoningOptions = chosen.supportedReasoningEfforts ?? [];
  let reasoningEffort = chosen.defaultReasoningEffort ?? null;

  if (reasoningOptions.length > 1) {
    console.log('\nReasoning efforts for this model:');
    reasoningOptions.forEach((option, idx) => {
      const description = option.description ? ` - ${option.description}` : '';
      console.log(`  [${idx + 1}] ${option.reasoningEffort}${description}`);
    });

    const effortChoice = await askLine('Choose reasoning effort (press Enter for model default): ');
    if (effortChoice) {
      const effortIndex = Number.parseInt(effortChoice, 10);
      if (!Number.isNaN(effortIndex) && effortIndex >= 1 && effortIndex <= reasoningOptions.length) {
        reasoningEffort = reasoningOptions[effortIndex - 1].reasoningEffort;
      } else {
        console.log('Invalid reasoning effort selection. Using model default from protocol.');
      }
    }
  }

  await request('setDefaultModel', { model: modelIdentifier, reasoningEffort: reasoningEffort ?? null });
  const name = toDisplayString(chosen.displayName ?? chosen.model ?? chosen.id, '(unknown model)');
  const reasoningLabel = reasoningEffort ? ` with reasoning ${reasoningEffort}` : '';
  console.log(`Updated default model to ${name}${reasoningLabel}.`);
}

module.exports = { run };
