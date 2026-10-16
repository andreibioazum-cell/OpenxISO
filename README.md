## RU

**OpenxISO** — эмулятор персонального компьютера для Android с поддержкой
**64-битных систем** (x86-64, длинный режим). Этот репозиторий содержит веб-
приложение эмулятора, движок и Android-обёртку, которая показывает его в
WebView.

Что умеет:

- загрузка **ISO** (CD/DVD) и **образов жёсткого диска** (.hdd, .img, .raw) —
  файлы выбираются из памяти телефона или копируются в приложение; в комплекте
  есть и свой загрузочный CD (`emulator/images/linux-6.6-x86_64.iso`), который
  грузит настоящий Linux 6.6 через BIOS, как обычный дистрибутивный диск;
- загрузка **образа ядра Linux** (bzImage, vmlinuz) — в комплекте есть
  настоящий Linux 6.6 для x86-64 с BusyBox: он поднимается из одного файла,
  печатает журнал загрузки на экран, отвечает на команды в консоли COM1,
  звучит через PC Speaker (`beep`), а подключённые к машине образы видит как
  `/dev/sda` и `/dev/sr0` и монтирует их сам (тот же Linux грузится и с CD —
  `?demo=cd` в веб-приложении);
- **интерфейс как в VirtualBox**: список машин, кнопки питания, экран гостевой
  системы, вкладки свойств, снимки состояния;
- **звук** (Sound Blaster 16 и PC Speaker) с регулятором громкости;
- **мышь и клавиатура**: захват мыши по нажатию на экран, виртуальная мышь для
  сенсорных экранов, экранная клавиатура и вставка текста;
- **консоль COM1** с возможностью отправлять команды;
- **снимки состояния**: память и устройства машины сохраняются и
  восстанавливаются; изменения гостя в образах дисков можно выгрузить файлом;
- работа **офлайн** и установка как приложение (PWA).

- Минимум: Android 8
- Цель: Android 15

Документация эмулятора — в [emulator/README.md](emulator/README.md).
Подробности о предыдущей версии продукта, правовой информации и лицензии — ниже.

## Что было раньше: Cubic Battle 4

Репозиторий вырос из игры Cubic Battle 4 (C + Java, движок на Vulkan). Код игры
остаётся в `src/`, `assets/`, `platform/android/java/com/cb4/GameActivity.java` и
собирается тем же workflow; из запускаемых приложений в APK входят два: OpenxISO
(по умолчанию) и игра.

## Правовая информация

Возрастная категория 12+. Пользовательское соглашение, политика обработки
персональных данных и согласие на обработку лежат в [docs/legal](docs/legal);
там же список того, что владелец должен сделать вне кода (уведомление
Роскомнадзора, локализация данных и т. д.).

## Лицензия

Copyright (C) 2026 Дима Густенёв

Все права защищены. Код и материалы проекта нельзя копировать, использовать,
изменять или распространять без письменного разрешения правообладателя.
Полные условия - в файле [LICENSE](LICENSE).

Исключение: движок эмулятора в `emulator/vendor/v86_64/` — это сторонний код
под лицензией BSD-2-Clause (v86_64, форк v86) вместе с BIOS SeaBIOS (LGPLv3);
тексты лицензий лежат рядом с файлами движка.

SPDX-License-Identifier: LicenseRef-Proprietary

## EN

**OpenxISO** — a PC emulator for Android with support for **64-bit guests**
(x86-64, long mode). The repository contains the web application of the emulator,
the engine, and the Android wrapper that shows it in a WebView. It boots real
operating systems from ISO files and hard disk images stored on the phone, and is
laid out like VirtualBox: a machine list, power buttons, the guest screen, tabbed
properties and snapshots.

Documentation: [emulator/README.md](emulator/README.md).

The repository started as the game Cubic Battle 4 (C with a bit of Java); its
sources are still built by the same workflow and shipped in the same APK.

- Minimum: Android 8
- Target: Android 15

## Legal

Age rating 12+. The Terms of Use, the personal data policy and the consent
form (in Russian) are in [docs/legal](docs/legal).

## License

Copyright (C) 2026 Дима Густенёв. All rights reserved; see [LICENSE](LICENSE).
The emulator engine in `emulator/vendor/v86_64/` is third-party code under
BSD-2-Clause (v86_64, a fork of v86) with SeaBIOS (LGPLv3), see the license files
next to it.
