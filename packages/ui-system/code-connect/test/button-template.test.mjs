import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Script, createContext } from 'node:vm';

const template = await readFile(new URL('../Button.figma.ts', import.meta.url), 'utf8');
const source = await readFile(new URL('../../src/components.tsx', import.meta.url), 'utf8');
const styles = { Primary: 'primary', Secondary: 'secondary', Danger: 'danger' };
const states = ['Default', 'Hover', 'Focus', 'Disabled', 'Busy'];

function render(style, state, label) {
  const accessed = [];
  const context = createContext({
    figma: {
      selectedInstance: {
        getString(name) { assert.equal(name, 'Label'); accessed.push(name); return label; },
        getEnum(name, mapping) {
          const options = name === 'Style' ? Object.keys(styles) : states;
          assert.deepEqual(Object.keys(mapping).sort(), [...options].sort());
          assert.ok(name === 'Style' || name === 'State');
          accessed.push(name);
          return mapping[name === 'Style' ? style : state];
        },
      },
      code(strings, ...values) { return strings.reduce((result, part, i) => result + part + (values[i] ?? ''), ''); },
    },
  });
  const executable = template.replace(/^import figma from 'figma';\s*$/m, '').replace('export default {', 'globalThis.result = {');
  new Script(executable, { filename: 'Button.figma.ts' }).runInContext(context, { timeout: 1000 });
  assert.deepEqual(accessed.sort(), ['Label', 'State', 'Style']);
  return context.result;
}

for (const [style, variant] of Object.entries(styles)) {
  for (const state of states) {
    test(`${style} / ${state} maps to the real Button contract`, () => {
      const result = render(style, state, 'Continue');
      assert.equal(result.id, 'teamaibox-button');
      assert.equal(result.metadata.nestable, true);
      assert.match(result.example, new RegExp(`^<Button variant="${variant}"`));
      assert.equal(/\sdisabled(?:\s|>)/.test(result.example), state === 'Disabled');
      assert.equal(/\sbusy(?:\s|>)/.test(result.example), state === 'Busy');
      assert.match(result.example, />Continue<\/Button>$/);
      assert.doesNotMatch(result.example, /\b(?:state|hover|focus|loading|label)=/);
      assert.ok(result.imports.includes('import { Button } from "@teamaibox/ui-system/components";'));
    });
  }
}

test('template uses dynamic text and the existing busy/disabled component, not a new UI implementation', () => {
  assert.match(render('Primary', 'Default', '保存').example, />保存<\/Button>/);
  assert.match(source, /disabled=\{disabled \|\| busy\}/);
  assert.match(source, /aria-busy=\{busy \|\| undefined\}/);
  assert.match(template, /example: figma\.code`/);
  assert.doesNotMatch(template, /figma\.connect\(|fetch\(|localStorage|process\.env/);
});
