import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';

for (const app of ['ocr','translation','asr','messaging','team-drive','drawing']) {
  test(`${app}: keyboard focus CSS stays inside the app on a slashless document URL`, async () => {
    const source = await readFile(new URL(`../../../apps/${app}-plugin/src/public/app.js`, import.meta.url),'utf8');
    assert.match(source,/focusStylesheet\.href\s*=\s*new URL\("\.\/focus\.css", import\.meta\.url\)\.href/);
    const document = `https://example.test/plugins/official.${app}`;
    const module = `${document}/app.js`;
    assert.equal(new URL('./focus.css',module).href,`${document}/focus.css`);
    assert.notEqual(new URL('./focus.css',document).href,`${document}/focus.css`);
  });
}
