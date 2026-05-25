import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? '/bare-metal-eo-matrix-app/' : '/',
  plugins: [wasm(), topLevelAwait()],
  build: { target: 'esnext' },
  optimizeDeps: {
    exclude: ['@matrix-org/matrix-sdk-crypto-wasm'],
  },
});
