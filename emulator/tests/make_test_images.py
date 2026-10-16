#!/usr/bin/env python3
"""Build the boot images the emulator tests use.

The tests boot these images through the emulator, so they exercise the whole
stack: SeaBIOS, the emulated IDE/ATA controller, the media backend that streams
the image (a file, a Blob, or a plain buffer) and the 64-bit CPU.

Two images are produced in build/emulator-tests/:

  long-mode-test.iso  ISO9660 with an El Torito (no emulation) entry that boots
                      emulator/tests/boot64.S. The ISO is assembled here, byte by
                      byte, so no mkisofs/xorriso is needed.
  long-mode-test.hdd  64 MiB raw disk image whose MBR is the same code; the rest
                      of the program is read from the disk with INT 13h, which
                      makes the test cover the hard disk path as well.

boot64.S switches the CPU to 64-bit long mode, prints over COM1 (the tests
assert on that output), writes to the VGA text buffer and beeps the speaker.

Usage: python3 emulator/tests/make_test_images.py [--out DIR]
"""

import argparse
import hashlib
import os
import shutil
import struct
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
SOURCE = os.path.join(HERE, "boot64.S")

SECTOR = 512
BLOCK = 2048
IMAGE_BASE = 0x7C00
MAGIC = 0x0BADC0DE
HDD_SIZE = 64 * 1024 * 1024


def build_boot_binary(out_dir):
    """Assemble boot64.S into a flat binary that is linked for 0x7c00."""
    asm = shutil.which("as")
    ld = shutil.which("ld")
    if not asm or not ld:
        raise SystemExit("error: binutils (as, ld) is required to build the test images")

    # boot64.S uses the C preprocessor for its constants, so preprocess it
    # first (cpp comes with gcc, clang can do it as well).
    if shutil.which("cpp"):
        preprocess = ["cpp", "-P", SOURCE]
    elif shutil.which("clang"):
        preprocess = ["clang", "-E", "-P", "-x", "assembler-with-cpp", SOURCE]
    elif shutil.which("cc"):
        preprocess = ["cc", "-E", "-P", "-x", "assembler-with-cpp", SOURCE]
    else:
        raise SystemExit("error: a C preprocessor (cpp/clang/cc) is required")

    source = os.path.join(out_dir, "boot64.s")
    obj = os.path.join(out_dir, "boot64.o")
    binary = os.path.join(out_dir, "boot64.bin")
    with open(source, "wb") as f:
        subprocess.run(preprocess, check=True, stdout=f)
    subprocess.run([asm, "--64", source, "-o", obj], check=True)
    subprocess.run(
        [ld, "-m", "elf_x86_64", "-Ttext", hex(IMAGE_BASE), "-e", "_start",
         "--oformat", "binary", obj, "-o", binary],
        check=True,
    )
    with open(binary, "rb") as f:
        image = f.read()

    if image[510:512] != b"\x55\xaa":
        raise SystemExit("error: the boot signature ended up at the wrong offset")
    if struct.unpack_from("<I", image, 512)[0] != MAGIC:
        raise SystemExit("error: the continuation magic ended up at the wrong offset")
    if not 512 < len(image) <= 16 * SECTOR:
        raise SystemExit(
            "error: the image is %d bytes, expected between 513 and %d "
            "(the boot sector reads 16 sectors)" % (len(image), 16 * SECTOR)
        )
    return image


def both_endian16(value):
    return struct.pack("<H", value) + struct.pack(">H", value)


def both_endian32(value):
    return struct.pack("<I", value) + struct.pack(">I", value)


def dir_record(name, extent, size, is_dir, timestamp=None):
    """One ISO9660 directory record (ECMA-119 9.1)."""
    timestamp = timestamp or (126, 1, 1, 0, 0, 0, 0)  # 2026-01-01, UTC
    if is_dir:
        name = b"\x00" if name == "." else b"\x01"
    else:
        name = name.encode("ascii")
    length = 33 + len(name)
    if length % 2:
        length += 1
    rec = bytearray()
    rec.append(length)
    rec.append(0)                          # extended attribute length
    rec += both_endian32(extent)
    rec += both_endian32(size)
    rec += bytes(timestamp)
    rec.append(0x02 if is_dir else 0x00)   # file flags
    rec.append(0)                          # file unit size
    rec.append(0)                          # interleave gap
    rec += both_endian16(1)                # volume sequence number
    rec.append(len(name))
    rec += name
    if length > 33 + len(name):
        rec.append(0)
    assert len(rec) == length, (len(rec), length)
    return bytes(rec)


def path_table(extent, big_endian):
    rec = bytearray()
    rec.append(10)                         # record length
    rec.append(0)                          # extended attribute length
    rec += struct.pack(">I" if big_endian else "<I", extent)
    rec += struct.pack(">H" if big_endian else "<H", 1)  # parent directory
    rec.append(1)                          # directory identifier length
    rec.append(0)                          # identifier: the root directory
    assert len(rec) % 2 == 0
    return bytes(rec)


def build_iso(boot_image, out_path):
    boot_blocks = (len(boot_image) + BLOCK - 1) // BLOCK

    lba_pvd = 16
    lba_boot_record = 17
    lba_terminator = 18
    lba_catalog = 19
    lba_root = 20
    lba_path_l = 21
    lba_path_m = 22
    lba_readme = 23
    lba_boot_image = 24
    total_blocks = lba_boot_image + boot_blocks

    readme_text = (
        "v86 emulator boot test\r\n"
        "\r\n"
        "This ISO boots emulator/tests/boot64.S: SeaBIOS loads the El Torito\r\n"
        "entry, the CPU switches to 64-bit long mode and the program reports\r\n"
        "over COM1 and on the screen.\r\n"
    ).encode("ascii")

    boot_catalog = bytearray(BLOCK)
    # Validation entry
    boot_catalog[0] = 0x01                      # header id
    boot_catalog[1] = 0x00                      # platform: x86
    boot_catalog[2:4] = b"\x00\x00"             # reserved
    boot_catalog[4:28] = b"v86 emulator test".ljust(24, b"\x00")
    boot_catalog[30:32] = b"\x55\xaa"           # key bytes
    checksum = (-sum(struct.unpack("<16H", boot_catalog[0:32]))) & 0xFFFF
    boot_catalog[28:30] = struct.pack("<H", checksum)
    # Default entry: a bootable no-emulation image
    entry = bytearray(32)
    entry[0] = 0x88                             # boot indicator
    entry[1] = 0x00                             # media type: no emulation
    entry[2:4] = struct.pack("<H", 0x0000)      # load segment 0 -> 0x7c00
    entry[4] = 0x00                             # system type
    entry[6:8] = struct.pack("<H", (len(boot_image) + SECTOR - 1) // SECTOR)
    entry[8:12] = struct.pack("<I", lba_boot_image)
    boot_catalog[32:64] = entry

    root_dir = bytearray()
    root_dir += dir_record(".", lba_root, BLOCK, True)
    root_dir += dir_record("..", lba_root, BLOCK, True)
    root_dir += dir_record("README.TXT;1", lba_readme, len(readme_text), False)
    root_dir += b"\x00" * (BLOCK - len(root_dir))

    pvd = bytearray(BLOCK)
    pvd[0] = 1
    pvd[1:6] = b"CD001"
    pvd[6] = 1
    pvd[8:40] = b"V86 EMULATOR TEST".ljust(32, b" ")
    pvd[40:72] = b"LONG_MODE_TEST".ljust(32, b" ")
    pvd[80:88] = both_endian32(total_blocks)
    pvd[120:124] = both_endian16(1)             # volume set size
    pvd[124:128] = both_endian16(1)             # volume sequence number
    pvd[128:132] = both_endian16(BLOCK)         # logical block size
    pvd[132:140] = both_endian32(10)            # path table size
    pvd[140:144] = struct.pack("<I", lba_path_l)
    pvd[144:148] = struct.pack("<I", 0)
    pvd[148:152] = struct.pack(">I", lba_path_m)
    pvd[152:156] = struct.pack(">I", 0)
    pvd[156:190] = dir_record(".", lba_root, BLOCK, True)
    pvd[190:318] = b"V86 EMULATOR TEST".ljust(128, b" ")
    pvd[318:446] = b"v86 emulator test image".ljust(128, b" ")
    pvd[446:574] = b"v86 emulator test image".ljust(128, b" ")
    pvd[574:702] = b"v86".ljust(128, b" ")
    pvd[813:830] = b"2026010100000000\x00"
    pvd[830:847] = b"2026010100000000\x00"
    pvd[847:864] = b"0000000000000000\x00"
    pvd[864:881] = b"0000000000000000\x00"
    pvd[881] = 1                                # file structure version

    boot_record = bytearray(BLOCK)
    boot_record[0] = 0
    boot_record[1:6] = b"CD001"
    boot_record[6] = 1
    boot_record[7:39] = b"EL TORITO SPECIFICATION".ljust(32, b"\x00")
    boot_record[39:71] = b"v86 emulator test".ljust(32, b"\x00")
    boot_record[71:75] = struct.pack("<I", lba_catalog)

    terminator = bytearray(BLOCK)
    terminator[0] = 255
    terminator[1:6] = b"CD001"
    terminator[6] = 1

    blocks = []
    blocks.append(("system area", b"\x00" * (16 * BLOCK)))
    blocks.append(("pvd", bytes(pvd)))
    blocks.append(("boot record", bytes(boot_record)))
    blocks.append(("terminator", bytes(terminator)))
    blocks.append(("boot catalog", bytes(boot_catalog)))
    blocks.append(("root directory", bytes(root_dir)))
    blocks.append(("path table L", path_table(lba_root, False)))
    blocks.append(("path table M", path_table(lba_root, True)))
    blocks.append(("readme", readme_text.ljust(BLOCK, b"\x00")))
    blocks.append(("boot image", boot_image.ljust(boot_blocks * BLOCK, b"\x00")))

    with open(out_path, "wb") as f:
        offset = 0
        for name, data in blocks:
            data = data + b"\x00" * ((-len(data)) % BLOCK)
            f.write(data)
            offset += len(data)
        if offset != total_blocks * BLOCK:
            raise SystemExit("error: ISO size mismatch (%d != %d)" % (offset, total_blocks * BLOCK))

    return total_blocks


def build_hdd(boot_image, out_path):
    image = bytearray(HDD_SIZE)
    image[0:len(boot_image)] = boot_image

    # A minimal MBR partition table so the image looks like a real disk; the
    # boot code lives at LBA 0, the partition only marks the free space.
    start_lba = 2048
    sectors = HDD_SIZE // SECTOR - start_lba
    entry = bytearray(16)
    entry[0] = 0x80                     # bootable
    entry[1:4] = bytes([0x00, 0x02, 0x00])          # CHS first sector
    entry[4] = 0x83                     # Linux
    entry[5:8] = bytes([0xFE, 0xFF, 0xFF])          # CHS last sector
    entry[8:12] = struct.pack("<I", start_lba)
    entry[12:16] = struct.pack("<I", sectors)
    image[446:462] = entry
    image[510:512] = b"\x55\xaa"

    with open(out_path, "wb") as f:
        f.write(image)
    return len(image)


def checksum(path):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default=os.path.join(REPO, "build", "emulator-tests"))
    args = parser.parse_args()

    os.makedirs(args.out, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        boot_image = build_boot_binary(tmp)

    iso_path = os.path.join(args.out, "long-mode-test.iso")
    hdd_path = os.path.join(args.out, "long-mode-test.hdd")
    blocks = build_iso(boot_image, iso_path)
    hdd_size = build_hdd(boot_image, hdd_path)

    print("boot64.bin      %6d bytes" % len(boot_image))
    print("long-mode-test.iso  %6d bytes (%d blocks)  sha256 %s"
          % (blocks * BLOCK, blocks, checksum(iso_path)))
    print("long-mode-test.hdd  %6d bytes  sha256 %s"
          % (hdd_size, checksum(hdd_path)))
    print("sha256 of boot64.bin: %s" % hashlib.sha256(boot_image).hexdigest())


if __name__ == "__main__":
    sys.exit(main())
