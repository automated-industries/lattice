import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.lint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      // union types must use `type`, not `interface` — disable to allow mixed usage
      '@typescript-eslint/consistent-type-definitions': 'off',
      // `_`-prefixed args/vars are intentionally unused (interface-required stubs, etc.)
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Layering: the HTTP server is one client, never a requirement.
    //
    // Files that speak HTTP (`*routes.ts`, the server, the shared request/response
    // helpers) translate a request into a call on the product and a response back
    // out. Everything else IS the product, and has to stay callable without a
    // server — from a command line, a library call, or a background job. So a route
    // may import a capability, and a capability may never import a route. When that
    // inverts, the imported logic can only be reached by booting a server, and
    // headless support quietly rots.
    //
    // Overridden below for the adapters themselves and for the entry points whose
    // job is to START the server. The matching test (tests/unit/headless-layering)
    // checks the same thing against the whole tree, including dynamic imports,
    // which this rule cannot see.
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/*routes.js', '**/routes.js', '**/server.js', '**/http.js'],
              message:
                'This file serves HTTP, so importing it forces a server into a code path that may never listen on a port. Move the shared logic into a capability module under src/ops/ and re-export it from the route file so existing importers keep working.',
            },
          ],
        },
      ],
    },
  },
  {
    // The adapters themselves: routes call each other and share the HTTP helpers,
    // and the server dispatches to every route. That direction is the allowed one.
    files: ['src/**/*routes.ts', 'src/gui/server.ts', 'src/gui/http.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    // Process entry points may import the server module in order to start it —
    // that is the opposite of the problem above. They still may not reach into a
    // route file for logic.
    files: ['src/cli.ts', 'src/index.ts', 'src/desktop-entry.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/*routes.js', '**/routes.js', '**/http.js'],
              message:
                'An entry point may start the server, but must not reach into a route file for logic. Import the capability module under src/ops/ instead.',
            },
          ],
        },
      ],
    },
  },
  {
    // Test files: relax rules that are overly strict for test code
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/restrict-plus-operands': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/prefer-nullish-coalescing': 'off',
      // Test fakes implement async interfaces with no real awaits / empty bodies.
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-empty-function': 'off',
    },
  },
  {
    // Plain-Node build scripts (not part of the typed TS project) + generated/vendored trees.
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'docs-generated/**',
      'eslint.config.js',
      'scripts/**/*.mjs',
    ],
  },
);
