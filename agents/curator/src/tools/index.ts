import type { Tool } from '@strands-agents/sdk';
import { buildConcernsTools } from './concerns-ddb.js';
import { buildSubmitSkillTool, type SubmitSkillDeps } from './submit-skill.js';
import { buildListSkillAuthoringTool, type SkillAuthoringDeps } from './skill-authoring.js';
import { buildCuratorDoneTool } from './done.js';

/**
 * The curator's tools for one run. They are built per feedback event
 * and bound to that event's reviewer store and run limits; the model
 * never names the reviewer or the table.
 *
 *   list_concerns, get_concern                read the concerns store
 *   create_concern, bump_concern,
 *   update_concern, merge_concerns,
 *   delete_concern                            change it, once per run
 *   list_skill_authoring                      skill-writing guidance, at graduation
 *   submit_skill                              graduate a record to the reviewer's registry
 *   curator_done                              end the run
 */
export function assembleCuratorTools(deps: SubmitSkillDeps & { readonly authoring: SkillAuthoringDeps }): Tool[] {
  return [
    ...buildConcernsTools(deps),
    buildListSkillAuthoringTool(deps.authoring),
    buildSubmitSkillTool(deps),
    buildCuratorDoneTool(deps.run),
  ];
}
