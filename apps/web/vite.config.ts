import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const generatedRuntime:Plugin={
  name:'record-generated-runtime',
  async generateBundle(_options,bundle){
    const assets=[];
    for(const chunk of Object.values(bundle)){
      if(chunk.type!=='chunk'||chunk.name!=='rolldown-runtime')continue;
      if(chunk.moduleIds.length!==1||chunk.moduleIds[0]!=='\0rolldown/runtime.js')throw Error('Unexpected code in compiler runtime');
      const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(chunk.code));
      const sha256=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
      assets.push({file:chunk.fileName,sha256,kind:'rolldown-runtime',modules:chunk.moduleIds});
    }
    this.emitFile({type:'asset',fileName:'generated-runtime.json',source:JSON.stringify({version:1,assets})});
  },
};
export default defineConfig({
  plugins: [react(),generatedRuntime],
  build: {
    target: "es2022",
    // The release CSP allows self-hosted fonts, not inline data fonts.
    assetsInlineLimit: file => /\.(?:woff2?|ttf)$/i.test(file)?false:undefined,
    sourcemap: true,
    rolldownOptions: {
      output: { codeSplitting: { groups: [
        { name: "product-languages", test: /global-translations\.mjs$/ },
        // Keep Mermaid's parser entry facades with its implementation, still lazy.
        { name: "assistant-diagrams", test: /(?:mermaid|@mermaid-js)[/\\]/ },
        { name: "assistant-rich-messages", test: /(?:streamdown|@streamdown)(?:[/\\]|[+@])/ },
        { name: "react-runtime", test: /\0rolldown\/runtime\.js|\/node_modules\/(?:react|react-dom|scheduler)\// },
      ] } },
    },
  },
  server: {
    strictPort: true,
    port: 4173,
  },
});
