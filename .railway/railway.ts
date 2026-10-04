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
    deploy: {
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 5,
      // Memory, not CPU, is the bottleneck: at the 1 GB default the process GC-thrashes/OOM-pauses
      // under vision+voice+engine load (observed 13.8 s event-loop freeze; CPU stayed at 0.14 of 2 vCPU).
      // Raise the memory cap. (Within the Railway plan's per-service limit.)
      limitOverride: { containers: { memoryBytes: 2 * 1024 * 1024 * 1024 } },
    },
    healthcheck: "/api/health",
    // First boot runs migrations and Next startup; generous but bounded.
    healthcheckTimeout: 120,
    replicas: 1,
    volumeMounts: { "/data": data },
    env: {
      NODE_ENV: "production",
      DATA_DIR: "/data",
      // Demo-safe: vision extraction off reduces memory/CPU under live load (tutor + interlock use the
      // disclosed DOM channel, D3; vision accuracy is measured separately). Flip to "on" to exercise vision.
      VISION_EXTRACTION: "off",
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
