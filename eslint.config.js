import js from '@eslint/js';

export default [
  { ignores: ['node_modules/', 'data/', 'admin/static/vendor/'] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        setImmediate: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        fetch: 'readonly',
      },
    },
    rules: { 'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }] },
  },
  {
    files: ['admin/static/**/*.js'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        Alpine: 'readonly',
        localStorage: 'readonly',
        location: 'readonly',
        history: 'readonly',
        confirm: 'readonly',
        prompt: 'readonly',
        CustomEvent: 'readonly',
        URLSearchParams: 'readonly',
        FileReader: 'readonly',
        HTMLTextAreaElement: 'readonly',
      },
    },
  },
];
