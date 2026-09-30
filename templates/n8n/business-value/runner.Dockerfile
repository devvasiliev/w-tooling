FROM node:22.22.0-alpine3.22@sha256:7aa86fa052f6e4b101557ccb56717cb4311be1334381f526fe013418fe157384

WORKDIR /app

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --chown=node:node config/business-value-assessment.schema.json config/
COPY --chown=node:node config/business-value-codex-envelope.schema.json config/
COPY --chown=node:node config/business-value-evidence.schema.json config/
COPY --chown=node:node config/business-value-evaluator.schema.json config/
COPY --chown=node:node config/business-value-evaluator.v1.json config/
COPY --chown=node:node config/business-value-model.schema.json config/
COPY --chown=node:node config/business-value-model.v1.json config/
COPY --chown=node:node config/business-value-preview.schema.json config/
COPY --chown=node:node config/business-value-research-brief.schema.json config/
COPY --chown=node:node .project/business-value-build-manifest.json config/runtime-build-manifest.json
COPY --chown=node:node scripts/notion-workflow-lib.mjs scripts/business-value.mjs scripts/
COPY --chown=node:node scripts/business-value/audit.mjs scripts/business-value/audit.mjs
COPY --chown=node:node scripts/business-value/cleanup.mjs scripts/business-value/cleanup.mjs
COPY --chown=node:node scripts/business-value/errors.mjs scripts/business-value/errors.mjs
COPY --chown=node:node scripts/business-value/evidence.mjs scripts/business-value/evidence.mjs
COPY --chown=node:node scripts/business-value/evaluator.mjs scripts/business-value/evaluator.mjs
COPY --chown=node:node scripts/business-value/fingerprint.mjs scripts/business-value/fingerprint.mjs
COPY --chown=node:node scripts/business-value/guard.mjs scripts/business-value/guard.mjs
COPY --chown=node:node scripts/business-value/managed-section.mjs scripts/business-value/managed-section.mjs
COPY --chown=node:node scripts/business-value/notion-adapter.mjs scripts/business-value/notion-adapter.mjs
COPY --chown=node:node scripts/business-value/notion-setup.mjs scripts/business-value/notion-setup.mjs
COPY --chown=node:node scripts/business-value/preview-store.mjs scripts/business-value/preview-store.mjs
COPY --chown=node:node scripts/business-value/publisher.mjs scripts/business-value/publisher.mjs
COPY --chown=node:node scripts/business-value/renderer.mjs scripts/business-value/renderer.mjs
COPY --chown=node:node scripts/business-value/run-store.mjs scripts/business-value/run-store.mjs
COPY --chown=node:node scripts/business-value/runner-server.mjs scripts/business-value/runner-server.mjs
COPY --chown=node:node scripts/business-value/sanitizer.mjs scripts/business-value/sanitizer.mjs
COPY --chown=node:node scripts/business-value/scorer.mjs scripts/business-value/scorer.mjs
COPY --chown=node:node scripts/business-value/server-utils.mjs scripts/business-value/server-utils.mjs
COPY --chown=node:node scripts/business-value/source.mjs scripts/business-value/source.mjs

RUN mkdir -p /var/lib/task-business-value && chown node:node /var/lib/task-business-value

USER node
EXPOSE 8080
CMD ["node", "scripts/business-value/runner-server.mjs"]
