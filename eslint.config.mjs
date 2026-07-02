import { FlatCompat } from "@eslint/eslintrc";
import js from "@eslint/js";

const compat = new FlatCompat({
  baseDirectory: process.cwd(),
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all
});

export default [
  {
    ignores: [".next/**", "node_modules/**", "coverage/**", "playwright-report/**"]
  },
  ...compat.extends("next/core-web-vitals", "next/typescript")
];
