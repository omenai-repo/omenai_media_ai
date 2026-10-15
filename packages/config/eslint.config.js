import { defineConfig } from 'eslint/config';

import nodeConfig from './eslint/node.js';

export default defineConfig(nodeConfig, {
  languageOptions: {
    parserOptions: {
      tsconfigRootDir: import.meta.dirname,
    },
  },
});
