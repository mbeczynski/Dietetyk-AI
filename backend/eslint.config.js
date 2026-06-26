const js = require('@eslint/js');

// Minimalna konfiguracja ESLint dla backendu (Node.js, CommonJS). Celem jest
// wychwytywanie realnych błędów (nieużywane zmienne, niezadeklarowane globalne,
// brakujący await itp.), a nie wymuszanie stylu - dlatego startujemy od
// "recommended" bez dodatkowych, restrykcyjnych reguł stylistycznych (o styl
// formatowania dba Prettier, patrz .prettierrc).
module.exports = [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
        process: 'readonly',
        console: 'readonly',
        __dirname: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly'
      }
    },
    rules: {
      // Parametry/zmienne błędów w catch (np. `catch (e) {}` używane do
      // ignorowania błędów ALTER TABLE przy migracjach w db.js) nie powinny
      // wymuszać błędu lintera.
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_|^e$|^err$', caughtErrorsIgnorePattern: '^_|^e$|^err$' }],
      'no-empty': ['warn', { allowEmptyCatch: true }]
    }
  },
  {
    ignores: ['node_modules/**', 'backups/**', '*.db']
  }
];
