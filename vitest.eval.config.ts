import { defineConfig } from "vitest/config";

/** The quick judge eval: run with `npm run eval:quick`, never by `npm test`. */
export default defineConfig({
  test: {
    include: ["eval/**/*.eval.ts"],
  },
});
