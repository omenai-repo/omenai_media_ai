import { defineConfig } from 'eslint/config';

import baseConfig from '@repo/config/eslint/base';

export default defineConfig(baseConfig, {
  languageOptions: {
    parserOptions: {
      tsconfigRootDir: import.meta.dirname,
    },
  },
});
