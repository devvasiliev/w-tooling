---
name: integrate-distribution
description: Подключает произвольную поставку к w-releases, готовит адаптер lifecycle и проверенный ZIP, проверяет preflight и кодовый rollback.
---

# Подключение поставки

Прочитай `w-releases/README.md` и `docs/distribution-contract.md`. Найди
конфигурацию releases через реестр tooling. Имя и состав поставки задаёт команда.

Выясни источник готового payload, имя, версию, commit и способ запуска. Проверь
имеющиеся сборку и deploy scripts в репозитории владельца. Переиспользуй их.
Нужны четыре фазы: `preflight`, `deploy`, `verify`, `rollback`.

Для файловой поставки выполни `./release init NAME`. Созданный adapter публикует
payload в отдельный каталог и переключает `current`. Он подходит для статики,
бинарников и других автономных файлов. Процесс приложения и его restart при
необходимости добавь в adapter по штатному интерфейсу сервиса.

Для контейнеров, установщика или внешнего deploy подготовь собственный
`distributions/NAME/deploy.sh` и helper scripts. `preflight` проверяет зависимости
и совместимость до мутаций. `deploy` сохраняет предыдущее состояние до первого
изменения. `verify` проверяет наблюдаемый результат. `rollback` восстанавливает
код после частичного deploy. Пользовательские данные и volumes сохраняются.

Подготовь ZIP:

```sh
./release pack NAME --source /path/to/payload --version 1.0.0 \
  --commit FULL_SHA --set RELEASE_SET
./release release RELEASE_SET --preflight-only
```

При зависимости от других поставок опиши `compatibility.json` по контракту и
передай `--compatibility FILE`. Runtime отклоняет несовместимый общий состав.
Один файл hook можно передать через `--hook FILE` вместо adapter directory.

Проверь init → pack → preflight в изолированном каталоге. Для directory adapter
проверь также смену версии и rollback. Для custom adapter используй реальную
изолированную инфраструктуру владельца; fixture hooks подтверждают только runner.
Если нужного доступа нет, сообщи точную незавершённую проверку. Production deploy
выполняй только при прямом поручении пользователя.

Результат: зарегистрированный adapter, команда сборки, ZIP, проверки и команда
повторного выпуска. Описывай фактические обязанности hooks и их внешние зависимости.
