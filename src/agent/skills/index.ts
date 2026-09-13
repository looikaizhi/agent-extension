import type { Plugin } from '@/agent/context/plugins';
import { github } from './github';

/**
 * One site's skill (CONTEXT.md `Skill`): a few sentences for the model about
 * this site — what it calls things, which control does what. They reach the
 * prompt beside the element table, loaded whole by the page's domain; the
 * model still plans every step itself, and does not pick which skill to read.
 *
 * They used to carry executable flows as well, answered without a model. That
 * half had no reader left once every guide became either model-planned or an
 * inspector's fixed plan, and the text was the half a live run ever showed
 * changing what the model does.
 */
export interface SiteSkill {
  domains: readonly string[];
  text: string;
}

/** Shipped as TS modules. A YAML loader arrives with remote community skills;
 *  adding it now would be speculative configuration. */
const SITE_SKILLS: readonly SiteSkill[] = [github];

function skillsFor(url: string): SiteSkill[] {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return [];
  }
  return SITE_SKILLS.filter((s) => s.domains.some((d) => host === d || host.endsWith(`.${d}`)));
}

/**
 * What a human wrote down about the site a page belongs to.
 *
 * This is where a site's own vocabulary belongs — how its search box wants a
 * query, what its odd control names mean — and deliberately not in the system
 * message: a general prompt that carries one site's search syntax makes every
 * other site's users pay for it, and the list can never be finished. A page
 * with no skill gets nothing, which is the normal case.
 *
 * Several skills can match one URL; their text is joined, because a skill is
 * scoped by domain and two that both matched are both about this page.
 *
 * The first `Plugin`, and on by default: its paragraph, lead-in included, is
 * exactly what the guide's user message carried before Plugins existed.
 */
export const skill: Plugin = {
  name: 'skill',
  defaultOn: true,
  contextFor(url) {
    const texts = skillsFor(url)
      .map((s) => s.text)
      .filter((t) => Boolean(t));
    return texts.length ? `关于这个站点，你需要知道：\n${texts.join('\n')}` : undefined;
  },
};
