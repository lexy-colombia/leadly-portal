import { supabase } from '../supabaseClient'
import type { AiSkill } from '../../types/domain'

/** The fixed catalog of skills Leadly offers -- adding a new one always
 * requires code (a new tool in _shared/aiTools.ts + an executor case in
 * whatsapp-ai-tools), so this only ever reads what already exists. */
export async function listAiSkills(): Promise<AiSkill[]> {
  const { data, error } = await supabase.from('ai_skills').select('*').eq('is_active', true).order('name')
  if (error) throw error
  return data
}

/** Which skill keys are currently enabled for a given assistant. */
export async function listEnabledSkillKeys(assistantId: string): Promise<Set<string>> {
  const { data, error } = await supabase.from('ai_assistant_skills').select('skill_key').eq('ai_assistant_id', assistantId)
  if (error) throw error
  return new Set(data.map((row) => row.skill_key))
}

/** Enabling/disabling is a superadmin-only action (RLS-enforced) -- the
 * bridge row has no business identity of its own, so this is a real
 * insert/delete, not a soft-delete (same exception as tag assignments). */
export async function setSkillEnabled(assistantId: string, skillKey: string, enabled: boolean, enabledBy: string): Promise<void> {
  if (enabled) {
    const { error } = await supabase.from('ai_assistant_skills').insert({ ai_assistant_id: assistantId, skill_key: skillKey, enabled_by: enabledBy })
    if (error) throw error
  } else {
    const { error } = await supabase.from('ai_assistant_skills').delete().eq('ai_assistant_id', assistantId).eq('skill_key', skillKey)
    if (error) throw error
  }
}
