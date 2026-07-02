export default [
  {
    ignores: [".next/**", "node_modules/**", "coverage/**"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module"
    },
    rules: {
      "no-unused-vars": "off"
    }
  }
];
