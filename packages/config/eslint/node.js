import { defineConfig } from 'eslint/config';
import globals from 'globals';

import baseConfig from './base.js';

/** Shared ESLint config for code that runs on Node.js. */
export default defineConfig(baseConfig, {
  languageOptions: {
    globals: globals.node,
  },
});
