import { defineConfig, transformWithEsbuild } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPclFilterMiddleware } from './scripts/pcl-filter-middleware.js';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

const pclFilterPlugin = {
  name: 'pcl-vertical-wall-filter',
  configureServer(server) {
    server.middlewares.use(createPclFilterMiddleware(projectRoot));
  },
  configurePreviewServer(server) {
    server.middlewares.use(createPclFilterMiddleware(projectRoot));
  },
};

export default defineConfig({
  plugins: [
    pclFilterPlugin,
    {
      name: 'load-js-as-jsx',
      enforce: 'pre',
      async transform(code, id) {
        if (!/src\/.*\.[jt]sx?$/.test(id)) return null;
        return transformWithEsbuild(code, id, {
          loader: id.endsWith('.ts') || id.endsWith('.tsx') ? 'tsx' : 'jsx',
          jsx: 'automatic',
        });
      },
    },
    react({ include: '**/*.{js,jsx,ts,tsx}' }),
  ],
  esbuild: {
    loader: 'jsx',
    include: /src\/.*\.js$/,
  },
  optimizeDeps: {
    esbuildOptions: {
      loader: {
        '.js': 'jsx',
      },
    },
  },
});
