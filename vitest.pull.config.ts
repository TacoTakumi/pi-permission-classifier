import { defineConfig } from "vitest/config";

/** The judged ask pull: run with `npm run data:pull`, never by `npm test`. */
export default defineConfig({
  test: {
    include: ["eval/pull.run.ts"],
  },
});
