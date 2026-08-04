import { supabase } from '../supabaseClient'

export type AiKeyProvider = 'openai' | 'gemini'

export async function hasPlatformAiKey(provider: AiKeyProvider): Promise<boolean> {
  const { data, error } = await supabase.rpc('has_platform_ai_key', { p_provider: provider })
  if (error) throw error
  return !!data
}

export async function setPlatformAiKey(provider: AiKeyProvider, key: string): Promise<void> {
  const { error } = await supabase.rpc('set_platform_ai_key', { p_provider: provider, p_key: key })
  if (error) throw error
}
