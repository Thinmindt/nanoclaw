/**
 * Guards the fork's Scout template (templates/engineering/scout) against drift
 * in NanoClaw's plugin reader: it must load through the real `parseTemplate`
 * with nothing skipped, declare no MCP server and no task, link only to files
 * that exist, and carry no address for the agent to open. Installed by the
 * add-scout skill; removed with it.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { parseTemplate } from './parse.js';

const TEMPLATE_DIR = path.resolve(__dirname, '../../templates/engineering/scout');

describe('fork template: engineering/scout', () => {
  it('loads through the plugin reader with every component accepted', () => {
    const tpl = parseTemplate(TEMPLATE_DIR);

    expect(tpl.report).toEqual([]);
    expect(tpl.name).toBe('scout');
    expect(tpl.agentName).toBe('Scout');
    expect(tpl.mcpServers).toEqual({});
    expect(tpl.tasks).toEqual([]);
    expect(tpl.skills.map((s) => s.name)).toEqual(['scout']);
    expect(tpl.instructions).toContain('`scout` skill');
    expect(tpl.instructions).toMatch(/never open an address/);
  });

  it('references only files that exist inside the skill, and no address', () => {
    const files = walk(TEMPLATE_DIR).filter((f) => f.endsWith('.md') || f.endsWith('.json'));
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf-8');
      for (const [, target] of text.matchAll(/\]\(([^)#]+\.(?:md|mjs))(?:#[^)]*)?\)/g)) {
        expect(fs.existsSync(path.resolve(path.dirname(file), target)), `${file} -> ${target}`).toBe(true);
      }
      // The only addresses are the manifest's own metadata; the agent is
      // never handed one to open.
      if (!file.endsWith('plugin.json')) expect(text, file).not.toMatch(/https?:\/\//);
    }
  });
});

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}
