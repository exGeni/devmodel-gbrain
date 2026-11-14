/**
 * The sanitized environment for a Git child process in tests: Git's repository-locating variables and global
 * pathspec switches are dropped, so a run started from a git hook never writes into the caller's repository.
 * Transport and credential variables pass through, and so do the operator's environment `safe.directory` entries
 * (#7584); `extra` wins over all of them. Taken whole from gbrain's src/core/git-env.ts at v0.60.711.0, which the
 * test preload used before the product code was cut.
 */

/** `git rev-parse --local-env-vars` (Git 2.55): the variables that locate or reconfigure one repository. */
export const GIT_LOCAL_ENV_VARS = ['GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_IMPLICIT_WORK_TREE', 'GIT_GRAFT_FILE', 'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS', 'GIT_REPLACE_REF_BASE', 'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_COMMON_DIR', 'GIT_NAMESPACE'] as const;

/** Git's global pathspec switches; GIT_LITERAL_PATHSPECS is what `git --literal-pathspecs` exports to every hook and child. */
export const GIT_PATHSPEC_ENV_VARS = ['GIT_LITERAL_PATHSPECS', 'GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS'] as const;

const DROPPED = new Set<string>([...GIT_LOCAL_ENV_VARS, ...GIT_PATHSPEC_ENV_VARS]);

/**
 * #7584: the `safe.directory` entries the operator set through `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>`,
 * in order. Only this key survives a scrub: it relaxes Git's ownership check for directories the operator names and cannot run
 * code or reach the network, so carrying it lets a repository owned by another user be read the way plain `git` reads it.
 */
export function envSafeDirectories(source: NodeJS.ProcessEnv = process.env): string[] {
  const count = Number(source.GIT_CONFIG_COUNT);
  const values: string[] = [];
  for (let i = 0; Number.isInteger(count) && i < count; i++) {
    if (source[`GIT_CONFIG_KEY_${i}`]?.toLowerCase() === 'safe.directory') values.push(source[`GIT_CONFIG_VALUE_${i}`] ?? '');
  }
  return values;
}

/** `safe.directory` values as command-scope config in the environment, in order (an empty value resets the list, as in Git). */
export function safeDirectoryEnv(values: readonly string[]): NodeJS.ProcessEnv {
  if (!values.length) return {};
  const env: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: String(values.length) };
  values.forEach((value, i) => { env[`GIT_CONFIG_KEY_${i}`] = 'safe.directory'; env[`GIT_CONFIG_VALUE_${i}`] = value; });
  return env;
}

export function gitChildEnv(extra: NodeJS.ProcessEnv = {}, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (!DROPPED.has(key) && !/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) env[key] = value;
  }
  return { ...env, ...safeDirectoryEnv(envSafeDirectories(source)), ...extra };
}
