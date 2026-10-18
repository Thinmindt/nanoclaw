/**
 * Guards the fork's Architect template (templates/engineering/architect)
 * against drift in NanoClaw's plugin reader, and holds its one structural
 * promise: the agent has no web path. It must load through the real
 * `parseTemplate` with nothing skipped, declare no MCP server and no task,
 * link only to files that exist, route all three modes, and tell its Tech
 * lead to ask the Scout rather than search. Installed by the add-architect
 * skill; removed with it.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { parseTemplate } from './parse.js';

const TEMPLATE_DIR = path.resolve(__dirname, '../../templates/engineering/architect');
const REFS = path.join(TEMPLATE_DIR, 'skills', 'architecture', 'references');

describe('fork template: engineering/architect', () => {
  it('loads through the plugin reader with every component accepted', () => {
    const tpl = parseTemplate(TEMPLATE_DIR);

    expect(tpl.report).toEqual([]);
    expect(tpl.name).toBe('architect');
    expect(tpl.agentName).toBe('Architect');
    expect(tpl.mcpServers).toEqual({});
    expect(tpl.tasks).toEqual([]);
    expect(tpl.skills.map((s) => s.name)).toEqual(['architecture']);
    expect(tpl.instructions).toContain('`architecture` skill');
    expect(tpl.instructions).toMatch(/never have the web/);
  });

  it('routes review, planning, and scope verdict, and names the run folder', () => {
    const skill = fs.readFileSync(path.join(TEMPLATE_DIR, 'skills', 'architecture', 'SKILL.md'), 'utf-8');
    for (const ref of ['references/review.md', 'references/planning.md', 'references/scope-verdict.md']) {
      expect(skill).toContain(`(${ref})`);
    }
    expect(skill).toContain('/workspace/agent/runs/<run-id>/');
  });

  it('references only files that exist inside the skill', () => {
    const skillDir = path.join(TEMPLATE_DIR, 'skills', 'architecture');
    for (const file of walk(skillDir).filter((f) => f.endsWith('.md'))) {
      const text = fs.readFileSync(file, 'utf-8');
      for (const [, target] of text.matchAll(/\]\(([^)#]+\.(?:md|json))(?:#[^)]*)?\)/g)) {
        expect(fs.existsSync(path.resolve(path.dirname(file), target)), `${file} -> ${target}`).toBe(true);
      }
    }
  });

  it('sends the Tech lead to the Scout, never to a search tool', () => {
    const techLead = fs.readFileSync(path.join(REFS, 'agents', 'tech-lead.md'), 'utf-8');
    expect(techLead).toMatch(/no web/);
    expect(techLead).not.toMatch(/web search|search tools|web research/i);
    expect(techLead).toMatch(/learns only\s+which technologies you are curious about/);

    const workflow = fs.readFileSync(path.join(REFS, 'workflow.md'), 'utf-8');
    expect(workflow).not.toMatch(/open it once per distinct URL/);
    expect(workflow).toContain('(scout-rounds.md)');
  });

  it('ships every contract as valid JSON with the Scout wording', () => {
    const contracts = path.join(REFS, 'contracts');
    for (const name of fs.readdirSync(contracts)) {
      const parsed = JSON.parse(fs.readFileSync(path.join(contracts, name), 'utf-8')) as Record<string, unknown>;
      expect(parsed.$schema, name).toBeTruthy();
    }
    const brief = fs.readFileSync(path.join(contracts, 'tech-lead-current-brief.json'), 'utf-8');
    expect(brief).toContain('Scout');
    expect(brief).not.toMatch(/web research/);
  });
});

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}
