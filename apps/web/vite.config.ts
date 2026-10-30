import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    target: "es2022",
    sourcemap: true,
    rolldownOptions: {
      output: { codeSplitting: { groups: [{ name: "product-languages", test: /global-translations\.mjs$/ }] } },
    },
  },
  server: {
    strictPort: true,
    port: 4173,
  },
});
