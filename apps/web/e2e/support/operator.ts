/** The operator bearer (`CUSTOM_LLM_SECRET`) of every e2e server: a placeholder, valid nowhere else. */
export const E2E_OPERATOR_SECRET = "e2e-placeholder-secret-not-used-0123456789";

/** The env admin of every e2e server (ADMIN_USERNAME / ADMIN_PASSWORD); e2e/support/accounts.ts grants roles with it. */
export const E2E_ADMIN = { username: "e2e-admin", password: "e2e-admin-password-not-a-secret" } as const;
