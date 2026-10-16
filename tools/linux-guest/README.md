# Сборка гостевой системы Linux 6.6 для x86-64

Этот каталог собирает из исходников гостевую систему, которую эмулятор
загружает как файл ядра — `emulator/images/linux-6.6-x86_64.bzImage`
(настоящий Linux 6.6 для x86-64 с BusyBox внутри образа ядра).

```
python3 tools/linux-guest/build.py                  # ~3 минуты на двух ядрах
python3 tools/linux-guest/build.py --jobs 8
python3 tools/linux-guest/build.py --out-dir /tmp/guest-images
python3 tools/linux-guest/build.py --kernel-only    # без BusyBox (проверка сборки)
python3 tools/linux-guest/build.py --keep-cpio      # плюс initramfs отдельным файлом
```

Скрипт скачивает и кэширует исходники в рабочем каталоге
(`/tmp/openxiso-linux-guest` по умолчанию), чтобы повторная сборка была быстрой:

* Linux 6.6 — `https://codeload.github.com/torvalds/linux/tar.gz/refs/tags/v6.6`
* BusyBox 1.36.1 — `https://codeload.github.com/mirror/busybox/tar.gz/refs/tags/1_36_1`

## Что в каталоге

| файл | зачем |
| --- | --- |
| `build.py` | вся сборка: исходники → патчи → конфигурация → ядро → образы в `emulator/images` |
| `patches.py` | правки сборочного окружения (см. ниже), идемпотентные |
| `kconfshim.py` | замена `scripts/kconfig/conf` на `kconfiglib`: `--syncconfig`, `--olddefconfig`, `--defconfig=`, `--savedefconfig=` |
| `kconfiglib/` | `kconfiglib.py` (ISC), разбор файлов `Kconfig` и запись `.config`/`autoconf.h`; в `PATCH.txt` — что и почему в нём поправлено |
| `bc` | замена GNU `bc`: ядро вызывает `bc` ровно в одном месте (`kernel/time/timeconst.bc`), скрипт считает то же самое на Python |
| `config.fragment` | настройки ядра (единственное место, где описан состав ядра) |
| `busybox.fragment` | настройки BusyBox поверх `make defconfig` |
| `initramfs/` | скелет корневой файловой системы: `/init` → BusyBox, `/etc/inittab`, `/etc/init.d/rcS`, баннер, `/etc/motd` |
| `initramfs.devices` | список узлов устройств для initramfs (в дереве их не создать: сборка идёт не от root) |
| `beep.c` | крошечная программа для гостя: играет тон через драйвер PC Speaker, так что звук слышно изнутри 64-битной системы |

## Почему нужны `patches.py`, `kconfshim.py` и `bc`

В окружении, где собирается образ, нет `bison`, `flex` и `libelf`, поэтому две
вспомогательные программы ядра собрать нельзя:

* `scripts/kconfig/conf` генерируется из `parser.y` и `lexer.l` — нужны
  `bison` и `flex`;
* `tools/objtool/objtool` — нужен `libelf`.

Отсюда четыре правки (все они меняют только **сборочное окружение**, не
поведение гостя):

1. `make syncconfig` и `make olddefconfig` вызывают
   `scripts/kconfig/syncconfig.py` (это `kconfshim.py`) вместо `conf`;
2. `make prepare` не тянет `tools/objtool`, а вызовы `objtool` для каждого
   объектного файла становятся пустыми (`objtool := true` в
   `scripts/Makefile.lib`) — компилятор выдаёт то же, что и обычно, только без
   постобработки;
3. и 4. так как `objtool` не работает, не заявляются две возможности x86,
   которые существуют ровно для того, чтобы `objtool` переписывал код:
   `HAVE_STATIC_CALL_INLINE` и `HAVE_UACCESS_VALIDATION`. `CONFIG_OBJTOOL`
   остаётся включённым (`select HAVE_OBJTOOL if X86_64`): без него не
   собирается ассемблер x86-64, который использует макросы аннотаций.

`bc` нужен потому, что ядро всегда пересобирает `include/generated/timeconst.h`
через `echo $(CONFIG_HZ) | bc -q kernel/time/timeconst.bc`. Скрипт `bc`
повторяет арифметику этого маленького файла на Python и громко падает на любом
другом вызове — тихо неверный результат невозможен.

## Как получается конфигурация

`config.fragment` — не полный `.config`, а перечень решений: `.config` из него
делает сам kernel Makefile:

```
make syncconfig     # запускает kconfshim.py, тот досчитывает зависимости и
                    # пишет .config, include/config/auto.conf, autoconf.h
```

`build.py` дописывает в конце `CONFIG_INITRAMFS_SOURCE` — два пути: собранный
initramfs (скелет + BusyBox) и список узлов устройств; в `config.fragment` этого
быть не может, потому что путь зависит от рабочего каталога. После `syncconfig`
скрипт проверяет, что в `.config` есть обязательные символы (`EXPECTED_CONFIG` в
`build.py`), и что `CONFIG_CC_VERSION_TEXT` не пустой — так ловится сборка с
конфигурацией «на глазок», в которой версия компилятора не попала в баннер ядра.

Что включено намеренно: 64-битное ядро, драйвер PC Speaker с evdev
(`CONFIG_INPUT_PCSPKR`, `CONFIG_INPUT_EVDEV` — иначе гостю нечем пищать), вывод через VGA-консоль (`CONFIG_VT`,
`CONFIG_VGA_CONSOLE`) и COM1 (`8250`, `SERIAL_8250_CONSOLE`), PS/2 клавиатура и
мышь (`i8042`), диски и CD-ROM (см. ниже), файловые системы образов, `devtmpfs`,
`proc`, `sysfs`, `tmpfs`, ELF и скрипты как исполняемые форматы, initramfs со
сжатием gzip. Что выключено: `SMP`, `ACPI`, сеть, модули, DRM/звуковая
подсистема — всё это в этой машине пока не используется, а размер и время сборки
растут быстро.

### Диски и CD-ROM

Движок показывает IDE-контроллер ровно так, как его показала бы настоящая машина
с PIIX3: PCI-функция `8086:7010`, класс `01/01`, `prog_if` «работает только в
режиме совместимости, поддерживает bus mastering», BAR0–BAR3 — порты
`0x1F0`/`0x3F6` и `0x170`/`0x376`, BAR4 — блок bus-master по адресу `0xB400`.
Линейка PCI у движка — 440FX с PIIX3, поэтому в `config.fragment` включены
`CONFIG_PCI`, `CONFIG_ATA`, `CONFIG_ATA_PIIX` и `CONFIG_ATA_BMDMA`: диск находит
libata через `ata_piix`, а обмен идёт по bus-master каналу, который движок
реализует (гость сам выбирает MWDMA2, см. `ata1: PATA max MWDMA2` в журнале).

`CONFIG_PATA_LEGACY` при этом выключен: PCI-функция занимает те же порты, и
драйвер старых ISA-портов всё равно отказался бы от них, а на машине без дисков
он бы только зря опрашивал пустые порты (PCI-функция IDE появляется у движка
только тогда, когда есть что показать).

Файловые системы для образов: `EXT2_FS`, `EXT4_FS` (тянет за собой `JBD2` и
`CRYPTO`), `VFAT_FS`/`MSDOS_FS`, `ISO9660_FS`, `NLS` с UTF-8 и cp437. Проверено
тестом `linux_test.mjs`: он форматирует подключённый `.hdd` гостевым `mkfs.ext2`,
монтирует, пишет файл, читает его обратно и убеждается, что файл на устройстве
при этом не изменился. Если образ уже с файловой системой, `rcS` монтирует его
сам при загрузке и печатает содержимое (`/mnt/disk` и `/mnt/cdrom`).

## Как проверить собранное

```
node emulator/tests/linux_test.mjs                  # загрузка, оболочка, COM1, экран
node emulator/tests/linux_ui_test.mjs               # то же через приложение в браузере
node emulator/tests/linux_test.mjs --keep-vga       # плюс текст виртуального экрана
```

Первый тест только Node (идёт в CI), второй требует puppeteer и Chrome — как и
остальные браузерные тесты, см. `emulator/README.md`.

## Ограничения

В образе одна машина, без сети, без SMP и без звуковой карты (звук — только
PC Speaker, см. `beep.c`); из пользовательских программ — BusyBox и то, что есть
в его составе. Записи гостя в подключённый образ живут в копии, которая есть у
эмулятора: файл на устройстве пользователя не меняется, а изменённый образ
можно выгрузить из приложения. Ядро непригодно как «настоящая» система для работы, его задача —
показать, что эмулятор действительно загружает 64-битную операционную систему и
даёт с ней работать: печатать, вводить команды с экрана и из консоли COM1,
слушать звук из гостя.

Сборка подписывает образ как `openxiso@guest-builder`
(`KBUILD_BUILD_USER`/`KBUILD_BUILD_HOST` в `build.py`) — это видно в баннере
ядра и в `/proc/version`, чтобы не путать образ с чьей-то локальной сборкой.
