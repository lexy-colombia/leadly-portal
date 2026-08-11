import { useState } from 'react'
import type { AiAssistantInput } from '../../lib/api/aiAssistants'
import type { AiAssistant, AiModel, AiProvider } from '../../types/domain'
import { isNotBlank, isValidMaxTokens, isValidTemperature } from '../../lib/validation'
import type { TranslationKey } from '../../i18n/translations'

export function useAiAssistantForm(initial: AiAssistant | null | undefined, models: AiModel[]) {
  const [name, setName] = useState(initial?.name ?? '')
  const [provider, setProviderRaw] = useState<AiProvider>(initial?.provider ?? 'openai')
  const [model, setModel] = useState(initial?.model ?? '')
  const [systemPrompt, setSystemPrompt] = useState(initial?.system_prompt ?? '')
  const [temperature, setTemperature] = useState(initial?.temperature ?? 0.7)
  const [maxTokens, setMaxTokens] = useState(initial?.max_tokens ?? 1024)
  const [isActive, setIsActive] = useState(initial?.is_active ?? false)
  const [touched, setTouched] = useState(false)

  const modelsForProvider = models.filter((m) => m.provider === provider)

  function setProvider(next: AiProvider) {
    setProviderRaw(next)
    // The previously selected model almost certainly doesn't belong to the new
    // provider -- default to the first available one instead of leaving an
    // invalid provider/model pair that the ai_assistants FK would reject.
    const firstForProvider = models.find((m) => m.provider === next)
    setModel(firstForProvider?.model_code ?? '')
  }

  // Returns translation keys (under settings.assistant.form.errors.*) instead of literal
  // messages -- AiAssistantDrawer.tsx resolves them with t() before rendering.
  const nameError: TranslationKey | undefined = touched && !isNotBlank(name) ? 'settings.assistant.form.errors.nameRequired' : undefined
  const modelError: TranslationKey | undefined = touched && !model ? 'settings.assistant.form.errors.modelRequired' : undefined
  const systemPromptError: TranslationKey | undefined =
    touched && isActive && !isNotBlank(systemPrompt) ? 'settings.assistant.form.errors.systemPromptRequired' : undefined
  const temperatureError: TranslationKey | undefined = touched && !isValidTemperature(temperature) ? 'settings.assistant.form.errors.temperatureRange' : undefined
  const maxTokensError: TranslationKey | undefined = touched && !isValidMaxTokens(maxTokens) ? 'settings.assistant.form.errors.maxTokensRange' : undefined

  function isValid() {
    return isNotBlank(name) && !!model && (!isActive || isNotBlank(systemPrompt)) && isValidTemperature(temperature) && isValidMaxTokens(maxTokens)
  }

  function toInput(): AiAssistantInput {
    return {
      name: name.trim(),
      provider,
      model,
      system_prompt: systemPrompt.trim(),
      temperature,
      max_tokens: maxTokens,
      is_active: isActive,
    }
  }

  return {
    name,
    setName,
    nameError,
    provider,
    setProvider,
    model,
    setModel,
    modelsForProvider,
    systemPrompt,
    setSystemPrompt,
    temperature,
    setTemperature,
    maxTokens,
    setMaxTokens,
    isActive,
    setIsActive,
    touched,
    setTouched,
    modelError,
    systemPromptError,
    temperatureError,
    maxTokensError,
    isValid,
    toInput,
  }
}

export type AiAssistantFormState = ReturnType<typeof useAiAssistantForm>
