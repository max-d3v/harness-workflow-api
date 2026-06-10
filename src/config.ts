export type ModeDefaultsName = "code_review" | "prompt" | "qa" | "qa_dev_server";
export type Effort = "low" | "medium" | "high" | "max";

// Controls verbose provider stream logs: reasoning, model text, tool calls, and step updates.
export const show_model_actions = true;

// When true, code review may submit a GitHub "request changes" review for blocking findings.
export const request_changes_when_needed = true;

interface ModeDefaults {
  model: string;
  effort: Effort;
}

export const provider_defaults = {
  codex: {
    code_review: {
      model: "gpt-5.5",
      effort: "medium",
    },
    prompt: {
      model: "gpt-5.5",
      effort: "high",
    },
    qa: {
      model: "gpt-5.4",
      effort: "medium",
    },
    qa_dev_server: {
      model: "gpt-5.5",
      effort: "medium",
    },
  },
  claude: {
    code_review: {
      model: "claude-opus-4-6",
      effort: "high",
    },
    prompt: {
      model: "claude-opus-4-7",
      effort: "high",
    },
    qa: {
      model: "claude-opus-4-6",
      effort: "medium",
    },
    qa_dev_server: {
      model: "claude-opus-4-6",
      effort: "medium",
    },
  },
} satisfies Record<string, Partial<Record<ModeDefaultsName, ModeDefaults>>>;

export type ProviderName = keyof typeof provider_defaults;

interface ResolveDefaultsInput {
  provider?: string;
  cli?: string;
  model?: string;
  effort?: Effort;
}

export function resolveProviderDefaults(mode: ModeDefaultsName, input: ResolveDefaultsInput) {
  const provider = input.cli ?? input.provider ?? "claude";
  if (!(provider in provider_defaults)) {
    throw new Error(`Unsupported provider "${provider}". Add it to provider_defaults before using it.`);
  }

  const providerConfig = provider_defaults[provider as ProviderName];
  const modeDefaults = providerConfig[mode];
  if (!modeDefaults && (!input.model || !input.effort)) {
    throw new Error(
      `No defaults configured for provider "${provider}" and mode "${mode}". Pass both model and effort or add provider_defaults.${provider}.${mode}.`,
    );
  }

  const model = input.model ?? modeDefaults?.model;
  const effort = input.effort ?? modeDefaults?.effort;
  if (!model) {
    throw new Error(`Missing model for provider "${provider}" and mode "${mode}".`);
  }
  if (!effort) {
    throw new Error(`Missing effort for provider "${provider}" and mode "${mode}".`);
  }

  return { provider: provider as ProviderName, model, effort };
}
