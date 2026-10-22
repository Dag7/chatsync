import { configDefaults, mergeConfig, type ViteUserConfig } from "vitest/config";

/**
 * The ONE vitest base every workspace project extends. Root-level on purpose
 * (build tooling, not runtime code), imported relatively so no build is needed.
 *
 * Vitest 4 no longer excludes `**\/dist/**` by default, so two guards keep
 * stale compiled tests out: `include` is anchored at `src/**`, and `exclude`
 * names `dist` explicitly. A project overriding `test.include` replaces the
 * base list; everything else deep-merges.
 */
const SOURCE_TEST_GLOBS = ["src/**/*.test.ts", "src/**/*.spec.ts"] as const;

const BASE: ViteUserConfig = {
  test: {
    globals: false,
    environment: "node",
    include: [...SOURCE_TEST_GLOBS],
    exclude: [...configDefaults.exclude, "**/dist/**", "**/coverage/**"],
    passWithNoTests: true,
  },
};

export function withChatsyncVitestDefaults(overrides: ViteUserConfig = {}): ViteUserConfig {
  const merged = mergeConfig(BASE, overrides) as ViteUserConfig;
  const ownInclude = overrides.test?.include;
  if (ownInclude && merged.test) merged.test.include = [...ownInclude];
  return merged;
}
