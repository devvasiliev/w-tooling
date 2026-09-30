import assert from "node:assert/strict";
import test from "node:test";

import { guardModelOutput, secretFingerprint } from "./business-value/guard.mjs";
import { sanitizeResearchBrief } from "./business-value/sanitizer.mjs";

const brief = {
  schemaVersion: 1,
  changeCategory: "retention",
  generalizedProblem: "W-456 в Example Suite теряет прогресс на https://notion.so/internal",
  audienceCategory: "Пользователи Example Suite",
  metricIds: ["d30_retention"],
  queries: [
    {
      id: "query-1",
      problemClass: "Сохранение прогресса между рабочими сессиями",
      audienceCategory: "Сотрудники, обрабатывающие заявки",
      metricIds: ["d30_retention"],
      keywords: ["resume workflow", "retention benchmark"],
    },
  ],
};

test("sanitizer удаляет внутренние идентификаторы и контакты", () => {
  const sanitized = sanitizeResearchBrief(brief, {
    confidentialText: "Закрытое содержание не совпадает с внешней формулировкой запроса.",
    productAliases: ["Example Suite"],
  });
  const serialized = JSON.stringify(sanitized);
  assert.doesNotMatch(serialized, /W-456|notion\.so|Example Suite/iu);
  assert.match(serialized, /product/iu);
});

test("sanitizer блокирует длинный закрытый фрагмент", () => {
  assert.throws(
    () =>
      sanitizeResearchBrief(
        {
          ...brief,
          generalizedProblem: "Пользователь теряет секретный внутренний контекст между длинными рабочими сессиями",
        },
        {
          confidentialText: "Пользователь теряет секретный внутренний контекст между длинными рабочими сессиями каждый день",
          productAliases: ["Example Suite"],
        },
      ),
    (error) => error.code === "EXTERNAL_SEARCH_PRIVACY_BLOCKED",
  );
});

test("единый guard отклоняет credential и PII без копирования payload", () => {
  const secret = "local-secret-value-123456";
  for (const output of [
    { summary: "token=super-secret-value-987654" },
    { rationale: "Напишите мне: person@example.com" },
    { rationale: `Получено ${secret}` },
  ]) {
    assert.throws(
      () =>
        guardModelOutput(output, {
          knownSecretHashes: [secretFingerprint(secret)],
        }),
      (error) => {
        assert.equal(error.code, "MODEL_OUTPUT_SECRET_DETECTED");
        assert.doesNotMatch(error.message, /super-secret|person@example|local-secret/iu);
        return true;
      },
    );
  }
});
