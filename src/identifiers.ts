/** CLI-safe Codex route identifiers shared by configuration and dispatch. */

export const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u
export const SAFE_REASONING_EFFORT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/u

/** App Server namespace whose callbacks are owned by the outer Harness loop. */
export const HARNESS_TOOL_NAMESPACE = 'deepseek_harness'
