/**
 * Railway infrastructure as code (D5). `railway.json` is deprecated and ignored for new services
 * (docs.railway.com/infrastructure-as-code); preview with `pnpm exec railway config plan`, apply with
 * `pnpm exec railway config apply`. Deploy the code with `pnpm exec railway up` (builds ./Dockerfile).
 *
 * Exactly one replica: SQLite lives on the attached volume, and Railway forbids replicas on a
 * service with a volume. Secrets are set with `railway variables` and only preserved here.
 */
import { defineRailway, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  // 500 MB is the cap on Railway's Trial/Free plan; raise after upgrading to Hobby (5 GB).
  const data = volume("vashistha-data", { sizeMB: 500 });

  const web = service("vashistha", {
    build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    deploy: { restartPolicyType: "ON_FAILURE", restartPolicyMaxRetries: 5 },
    healthcheck: "/api/health",
    // First boot runs migrations and Next startup; generous but bounded.
    healthcheckTimeout: 120,
    replicas: 1,
    volumeMounts: { "/data": data },
    env: {
      NODE_ENV: "production",
      DATA_DIR: "/data",
      // Default draining is 0 s (SIGKILL right after SIGTERM); server.ts drains for up to 10 s.
      RAILWAY_DEPLOYMENT_DRAINING_SECONDS: "15",
      PUBLIC_BASE_URL: preserve(),
      ANTHROPIC_API_KEY: preserve(),
      ELEVENLABS_API_KEY: preserve(),
      ELEVENLABS_INTERVIEWER_AGENT_ID: preserve(),
      ELEVENLABS_TUTOR_AGENT_ID: preserve(),
      CUSTOM_LLM_SECRET: preserve(),
      MCP_BEARER_TOKEN: preserve(),
    },
  });

  return project("vashistha", { resources: [web, data] });
});
