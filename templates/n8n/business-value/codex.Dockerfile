FROM node:22.22.0-alpine3.22@sha256:7aa86fa052f6e4b101557ccb56717cb4311be1334381f526fe013418fe157384

WORKDIR /opt/codex-runtime
COPY templates/n8n/business-value/codex-runtime/package.json templates/n8n/business-value/codex-runtime/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
  && ln -s /opt/codex-runtime/node_modules/@openai/codex/bin/codex.js /usr/local/bin/codex \
  && npm cache clean --force

WORKDIR /app
COPY config/business-value-assessment.schema.json config/
COPY config/business-value-codex-envelope.schema.json config/
COPY config/business-value-evidence.schema.json config/
COPY config/business-value-evaluator.schema.json config/
COPY config/business-value-evaluator.v1.json config/
COPY config/business-value-model.v1.json config/
COPY config/business-value-preview.schema.json config/
COPY config/business-value-research-brief.schema.json config/
COPY .project/business-value-build-manifest.json config/runtime-build-manifest.json
COPY config/prompts/business-value-external-research.md config/prompts/
COPY config/prompts/business-value-production-assessment.md config/prompts/
COPY config/prompts/business-value-research-brief.md config/prompts/
COPY scripts/business-value/codex-provider.mjs scripts/business-value/codex-provider.mjs
COPY scripts/business-value/codex-server.mjs scripts/business-value/codex-server.mjs
COPY scripts/business-value/codex-supervisor.mjs scripts/business-value/codex-supervisor.mjs
COPY scripts/business-value/errors.mjs scripts/business-value/errors.mjs
COPY scripts/business-value/evidence.mjs scripts/business-value/evidence.mjs
COPY scripts/business-value/evaluator.mjs scripts/business-value/evaluator.mjs
COPY scripts/business-value/guard.mjs scripts/business-value/guard.mjs
COPY scripts/business-value/serial-queue.mjs scripts/business-value/serial-queue.mjs
COPY scripts/business-value/server-utils.mjs scripts/business-value/server-utils.mjs

RUN mkdir -p /var/lib/codex /tmp/task-business-value-home \
  && chmod 0755 /app/scripts/business-value/codex-supervisor.mjs

EXPOSE 8081
CMD ["node", "scripts/business-value/codex-server.mjs"]
