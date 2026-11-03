/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from 'vite';
import { mockTvPairing } from './dev/mock-tv';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.DEV_API_TARGET || 'http://127.0.0.1:8080';
  return {
    plugins: env.VITE_MOCK_TV === '1' ? [mockTvPairing()] : [],
    esbuild: {
      jsx: 'automatic',
      jsxImportSource: 'preact',
      legalComments: 'none',
    },
    resolve: {
      alias: { react: 'preact/compat', 'react-dom': 'preact/compat' },
    },
    build: {
      // Module scripts + dynamic import: Chromium 63+, Safari 11.1+. Older
      // smart-TV engines without ES modules are out of scope.
      target: ['es2017', 'chrome63', 'safari11.1'],
      cssTarget: ['chrome61', 'safari11'],
      modulePreload: { polyfill: false },
      sourcemap: false,
      reportCompressedSize: false,
    },
    server: {
      proxy: {
        '/api': { target, changeOrigin: true },
        '/ws': { target, changeOrigin: true, ws: true },
      },
    },
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts'],
    },
  };
});
