import { loadProject } from "./project-config.mjs";

/** Реестр ограничивает синхронизацию явно подключёнными репозиториями. */
export function workspaceTargets(config = loadProject()) {
  return config.repositories.map(repository => ({
    name: repository.name,
    relativeRoot: repository.path,
    appendixName: repository.role === "tooling" ? "w-tooling.md" : repository.role === "releases" ? "w-releases.md" : "service.md",
  }));
}
