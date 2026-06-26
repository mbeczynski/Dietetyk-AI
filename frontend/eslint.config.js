import js from '@eslint/js';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

// Minimalna konfiguracja ESLint dla frontendu (React + Vite). Tak jak w
// backendowym eslint.config.js - celem jest wychwytywanie realnych błędów
// (hooki użyte poza komponentem, nieużywane zmienne, brakujące zależności
// w useEffect), nie wymuszanie stylu (o to dba Prettier, patrz .prettierrc).
export default [
  js.configs.recommended,
  {
    files: ['src/**/*.{js,jsx}'],
    plugins: { react, 'react-hooks': reactHooks },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        window: 'readonly',
        document: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        navigator: 'readonly',
        confirm: 'readonly',
        prompt: 'readonly',
        alert: 'readonly',
        FormData: 'readonly',
        FileReader: 'readonly',
        Image: 'readonly',
        URL: 'readonly'
      }
    },
    settings: { react: { version: 'detect' } },
    rules: {
      ...react.configs.recommended.rules,
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react/prop-types': 'off',
      'react/react-in-jsx-scope': 'off',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_|^e$|^err$', caughtErrorsIgnorePattern: '^_|^e$|^err$' }]
    }
  },
  {
    ignores: ['node_modules/**', 'dist/**']
  }
];
