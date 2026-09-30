# __SERVICE_NAME__

- Bounded context: __BOUNDED_CONTEXT__
- Business requirement / master specification: __BUSINESS_REQUIREMENT__
- Python package: `__SERVICE_PACKAGE__`
- HTTP port: `__SERVICE_PORT__`

## Где искать поведение

Каждая capability имеет отдельную краткую карту в `docs/capabilities/`. В ней
фиксируются use cases, invariants, contracts, persistence и acceptance tests.
Отсутствующая трассировка блокирует реализацию предметного поведения.

## Общий каркас

- `domain/` — предметные правила и модели без infrastructure dependencies.
- `application/` — use cases и ports.
- `adapters/inbound/` — HTTP, events и другие входы.
- `adapters/outbound/` — persistence и внешние интеграции.
- `bootstrap/` — только composition roots и process entrypoints.
