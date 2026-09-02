# Задача: Ansible-стенд для нагрузочного тестирования Postal

## Контекст и цель

Создать идемпотентный Ansible-проект, который разворачивает изолированный тестовый контур Postal (https://github.com/postalserver/postal ) и позволяет сравнивать производительность разных Docker-образов Postal.

Главное требование: распределение сервисов определяется **только Ansible inventory**. Один и тот же playbook должен работать в двух режимах:

1. Все компоненты размещены на одном физическом сервере — для дешёвой отладки.
2. Каждый компонент или несколько экземпляров одного компонента размещены на отдельных серверах — для финального нагрузочного тестирования в распределённой масштабируемой среде.

Не хардкодить IP-адреса, имена узлов и совместное размещение сервисов. Адреса зависимостей и списки реплик формировать из `groups` и `hostvars` inventory.

## Предпочтительная реализация

- Ansible roles + Jinja2 templates.
- Docker Engine и Docker Compose plugin на целевых серверах.
- Ubuntu 24.04 LTS x86_64 как базовая поддерживаемая ОС.
- Все версии образов должны быть зафиксированы тегом или digest.
- Мы на стадии PoC - для простоты не заботимся о безопасности совсем. Секреты хранить можно хоть в гите;
- Контейнеры должны иметь настраиваемые CPU/RAM limits.
- Повторный запуск playbook без изменения переменных не должен изменять инфраструктуру.

## Inventory groups

Предусмотреть следующие группы:

```yaml
postal_main_db:       # основная MariaDB Postal
postal_message_db:    # message DB; может совпадать с main DB
postal_admin:         # ровно один узел для initialize/update/migrations
postal_web:           # один или несколько web/API-инстансов
postal_smtp:          # один или несколько SMTP ingress-инстансов
postal_workers:       # один или несколько worker-узлов
postal_load_balancers:# необязательные HAProxy-инстансы

test_dns:             # внутренний DNS для тестовых MX
postfix_sinks:        # один или несколько принимающих Postfix
load_generators:      # генераторы SMTP/API-нагрузки
monitoring:           # Prometheus и отчёты
```

Один host разрешено включать сразу во все группы. Количество серверов в `postal_web`, `postal_smtp`, `postal_workers` и `postfix_sinks` не должно быть ограничено playbook.

Подготовить два примера inventory:

- `inventories/single-host/hosts.yml` — все роли на одном сервере;
- `inventories/distributed/hosts.yml` — каждый тип сервиса на отдельном сервере, несколько Postal workers и Postfix sinks.

Для межсерверного взаимодействия использовать переменную `service_ip`; при её отсутствии — приватный адрес из inventory.

## Необходимые роли

Необходимые роли определи сам.

## Важные переменные

Postal должен получать адреса `main_db`, `message_db` и список SMTP relays из inventory. При нескольких Postfix использовать все узлы; распределение выполнять через Postal relay configuration, внутренний DNS или HAProxy — способ должен задаваться переменной.

Для того чтобы не поднимать свой собственный DNS - можно использовать Облачное решение например Route53 но только в том случае если это действительно имеет смысл - Возможно мы сможем обойтись записями в файле hosts

## Безопасность теста

- Postfix должен работать только в закрытой сети и удалять письма через `discard` после штатного SMTP-приёма.
- Smoke test обязан подтвердить, что письмо прошло `load generator → Postal → Postfix → discard`.

## Критерии приёмки

- Оба sample inventory работают без изменения ролей или playbooks.
- Добавление worker, SMTP, web или Postfix сервера требует только изменения inventory.
- Один физический сервер может выполнять все роли одновременно.
- Все сервисы имеют healthchecks и после повторного запуска остаются в рабочем состоянии.
- Замена `postal_image` действительно разворачивает другой build без пересоздания всей инфраструктуры.
- Ни одно тестовое письмо не может уйти во внешний интернет.
- Счётчики позволяют проверить: `accepted = delivered_to_sink + failed + queued`.
- Отчёт содержит абсолютные значения и процентное изменение относительно baseline.
- Документация содержит команды для single-host, distributed, smoke, calibration, benchmark и reset.

## Результат работы агента

Готовый Git-репозиторий со структурой Ansible-проекта, ролями, двумя inventory, шаблонами конфигураций, примером Vault-файла без секретов, README и минимальным CI example.

Эта задача покрывает первые два этапа общего плана и подготавливает третий:

1. Setting up a test environment for comparing different builds.
2. Deploying the test environment.
3. Forking Postal and adding CI/CD-driven load tests.
4. Optimizing Postal and progressively replacing bottleneck components with custom implementations.
