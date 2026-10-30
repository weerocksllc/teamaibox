import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localeDefinitions } from '../packages/ui-system/src/locale-registry.mjs';
import { localizeLinks } from './document-localization.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const check=process.argv.includes('--check');
const filename=code=>code==='en'?'README.md':`README.${code}.md`;
const languages=[...localeDefinitions].sort((a,b)=>a.code==='en'?-1:b.code==='en'?1:0);
const languageLinks=languages.map(l=>`[${l.name}](${filename(l.code)})`).join(' · ');
const sparkCopy=JSON.parse(await fs.readFile(path.join(root,'docs/readme-locales/dgx-spark.json'),'utf8'));
const escape=s=>s.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
const keys=['intro','whyTitle','why','featuresTitle','features','screensTitle','screensNote','light','dark','installTitle','requirements','installExplanation','resumeTitle','resume','firstTitle','first','limitsTitle','limits','contributeTitle','contribute','resourcesTitle','resources'];
for(const locale of languages){
  const spark=sparkCopy[locale.code];
  if(!spark)throw new Error(`${locale.code}: missing DGX Spark copy`);
  const t=JSON.parse(await fs.readFile(path.join(root,'docs/readme-locales',locale.code+'.json'),'utf8'));
  for(const key of keys)if(!t[key])throw new Error(`${locale.code}: missing ${key}`);
  if(t.features.length!==11||t.first.length!==4||t.resources.length!==6)throw new Error(`${locale.code}: incomplete sections`);
  for(const theme of ['light','dark'])await fs.access(path.join(root,`docs/assets/screenshots/${locale.code}/workbench-${theme}.jpg`));
  const shot=`docs/assets/screenshots/${locale.code}/workbench`;
  const links=['install/SOURCE-INSTALL.md','install/README.md','docs/open-source/BUILDING.md','CONTRIBUTING.md','SECURITY.md','THIRD_PARTY_NOTICES.md'];
  const output=localizeLinks(`<!-- Generated from docs/readme-locales/${locale.code}.json by tools/render-readmes.mjs. -->
# ${spark.readmeTitle}

<p><img src="docs/assets/brand/mascot.png" alt="Team AI Box" width="160" height="160"></p>

**Powered by NVIDIA DGX Spark · MIT · Weerocks LLC**

<!-- README_LANGUAGE_SELECTOR -->

**${spark.heroTitle}** ${spark.description}

[teamaibox.com](https://teamaibox.com/) · [GitHub](https://github.com/weerocksllc/teamaibox) · [MIT](LICENSE) · [teamaibox@weerocks.llc](mailto:teamaibox@weerocks.llc)

## ${t.whyTitle}

${t.why.map(x=>`- ${x}`).join('\n')}

## ${t.screensTitle}

${t.screensNote}

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="${shot}-dark.jpg">
  <source media="(prefers-color-scheme: light)" srcset="${shot}-light.jpg">
  <img src="${shot}-light.jpg" alt="${escape(spark.screenshotAlt)} — ${escape(locale.name)}" width="1280">
</picture>

[${t.light}](${shot}-light.jpg) · [${t.dark}](${shot}-dark.jpg)

## ${spark.featuresTitle}

${t.features.map(([name,body])=>`### ${name}\n\n${body}`).join('\n\n')}

## ${spark.hardwareTitle}

${spark.hardwareBody}

${spark.hardwareNote}

${spark.value}

[${spark.sourceLabel}](https://docs.nvidia.com/dgx/dgx-spark/hardware.html)

${spark.independence}

<a id="install"></a>

## ${t.installTitle}

${t.requirements}

\`\`\`sh
git clone https://github.com/weerocksllc/teamaibox.git
cd teamaibox
sudo bash install/from-source.sh
\`\`\`

${t.installExplanation}

### ${t.resumeTitle}

${t.resume}

\`\`\`sh
sudo bash install/from-source.sh --check
sudo bash install/from-source.sh
\`\`\`

### ${t.firstTitle}

${t.first.map((x,i)=>`${i+1}. ${x}`).join('\n')}

## ${t.limitsTitle}

${t.limits}

## ${t.contributeTitle}

${t.contribute}

[Issues](https://github.com/weerocksllc/teamaibox/issues) · [Pull requests](https://github.com/weerocksllc/teamaibox/pulls) · [CONTRIBUTING](CONTRIBUTING.md) · [SECURITY](SECURITY.md)

## ${t.resourcesTitle}

${links.map((link,i)=>`- [${t.resources[i]}](${link})`).join('\n')}

\`apps/\` · \`services/\` · \`packages/\` · \`install/\` · \`deploy/\` · \`docs/\`

© 2026 Weerocks LLC. [MIT](LICENSE) · [${t.resources[5]}](docs/open-source/RELEASING.md)
`, 'README.md', locale.code).replace('<!-- README_LANGUAGE_SELECTOR -->',languageLinks);
  const target=path.join(root,filename(locale.code));
  if(check){if(await fs.readFile(target,'utf8')!==output)throw new Error(`${filename(locale.code)} is out of date`);}
  else await fs.writeFile(target,output);
}
console.log(`${check?'Verified':'Rendered'} ${languages.length} README languages and ${languages.length*2} localized screenshots.`);
