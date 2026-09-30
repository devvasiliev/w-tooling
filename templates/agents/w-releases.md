## Локальная ответственность

Runner применяет ZIP указанного release set. Проверяй checksum каждого файла,
двойной preflight и обратный rollback каждого начатого deploy.
Постоянные данные принадлежат сервисам. Hooks сохраняют volumes и схему данных.
Проверки: `bash tests/run-release.test.sh`.
