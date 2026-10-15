import { defineConfig } from 'eslint/config';

import nodeConfig from '@repo/config/eslint/node';

export default defineConfig(nodeConfig, {
  languageOptions: {
    parserOptions: {
      tsconfigRootDir: import.meta.dirname,
    },
  },
});
