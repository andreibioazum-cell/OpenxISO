#!/usr/bin/env python3
"""Build the small CD image that boots the guest kernel on a bare machine.

The result is ``emulator/images/linux-6.6-x86_64.iso``: an ISO9660 CD with one
El Torito (no emulation) entry, so a machine with nothing but a BIOS and this CD
boots a real 64-bit Linux - the same kernel image the page can pass to the
engine directly, booted the way a real machine boots it:

    SeaBIOS -> El Torito entry -> the loader in its first block (linuxboot.S)
            -> the kernel's own real mode entry point -> long mode -> BusyBox

The loader reads the kernel from the CD with INT 13h, so the CD holds it twice:
once inside the boot image (behind the loader) and once as a file, which is what
the second directory record points at::

    README.TXT;1    what the CD is
    OPENXISO.IMG;1  the boot image: linuxboot.S in the first 2048 byte block,
                    the kernel image right behind it
    LINUX.BIN;1     the kernel image on its own (the same blocks as above)

Nothing here needs mkisofs or xorriso: the image is assembled byte by byte and
everything in it has a fixed timestamp, so the same sources produce the same
file - which is what ``--check`` verifies against the copy in the repository.

The loader is assembled from ``linuxboot.S`` with cpp, as and ld, the same tools
``emulator/tests/make_test_images.py`` uses for ``boot64.S``.

Usage:
    python3 tools/linux-guest/mkiso.py                 # write the ISO in place
    python3 tools/linux-guest/mkiso.py --check         # is it up to date?
    python3 tools/linux-guest/mkiso.py --out /tmp/x.iso
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
LOADER_SOURCE = os.path.join(HERE, "linuxboot.S")
DEFAULT_KERNEL = os.path.join(REPO, "emulator", "images", "linux-6.6-x86_64.bzImage")
DEFAULT_OUT = os.path.join(REPO, "emulator", "images", "linux-6.6-x86_64.iso")

SECTOR = 512                    # the BIOS reads the CD in 512 byte sectors
BLOCK = 2048                    # ISO9660 blocks - and the CD's own block size
LOADER_BASE = 0x7C00            # where SeaBIOS puts a no emulation boot image
LOADER_BLOCKS = 1               # the loader has to fit in one block
TIMESTAMP = (126, 1, 1, 0, 0, 0, 0)     # 2026-01-01, and never the clock

LBA_PVD = 16
LBA_BOOT_RECORD = 17
LBA_TERMINATOR = 18
LBA_CATALOG = 19
LBA_ROOT = 20
LBA_PATH_L = 21
LBA_PATH_M = 22
LBA_README = 23
LBA_BOOT_IMAGE = 24

README_TEXT = (
    "OpenxISO guest CD\r\n"
    "=================\r\n"
    "\r\n"
    "This CD boots a real 64-bit Linux kernel on a bare machine: the BIOS\r\n"
    "reads the El Torito entry, the loader in its first block reads the kernel\r\n"
    "from this CD with INT 13h and enters it through the kernel's own 16-bit\r\n"
    "entry point, and the kernel switches to long mode, decompresses itself\r\n"
    "and starts its shell (BusyBox lives inside the kernel image, there is no\r\n"
    "need to boot from anything else).\r\n"
    "\r\n"
    "  LINUX.BIN      the kernel image: Linux 6.6 for x86-64\r\n"
    "  OPENXISO.IMG   the boot image: the loader plus the same kernel\r\n"
    "  README.TXT     this file\r\n"
    "\r\n"
    "The guest prints its log on the VGA console and on the serial port\r\n"
    "(COM1, 115200 baud), and has a shell on both.  Disk images attached to\r\n"
    "the machine show up as /dev/sda and CD images as /dev/sr0; the guest\r\n"
    "mounts the first filesystem it finds on a disk at /mnt/disk.\r\n"
    "\r\n"
    "Kernel and CD are built from source in the OpenxISO repository by\r\n"
    "tools/linux-guest/build.py and tools/linux-guest/mkiso.py.\r\n"
).encode("ascii")

README_BLOCKS = (len(README_TEXT) + BLOCK - 1) // BLOCK


def assemble_loader(out_dir):
    """Assemble linuxboot.S into a flat binary that is linked for 0x7c00."""
    cpp = shutil.which("cpp")
    asm = shutil.which("as")
    ld = shutil.which("ld")
    if not cpp or not asm or not ld:
        raise SystemExit("error: cpp and binutils (as, ld) are required to build the loader")

    source = os.path.join(out_dir, "linuxboot.s")
    obj = os.path.join(out_dir, "linuxboot.o")
    binary = os.path.join(out_dir, "linuxboot.bin")
    with open(source, "wb") as f:
        subprocess.run([cpp, "-P", LOADER_SOURCE], check=True, stdout=f)
    subprocess.run([asm, "--64", source, "-o", obj], check=True)
    subprocess.run(
        [ld, "-m", "elf_x86_64", "-Ttext", hex(LOADER_BASE), "-e", "_start",
         "--oformat", "binary", obj, "-o", binary],
        check=True,
    )
    with open(binary, "rb") as f:
        loader = f.read()

    if len(loader) > LOADER_BLOCKS * BLOCK:
        raise SystemExit(
            "error: the loader is %d bytes, it has to fit in %d (one CD block, "
            "because the kernel starts in the block behind it)"
            % (len(loader), LOADER_BLOCKS * BLOCK))
    return loader


def both_endian16(value):
    return struct.pack("<H", value) + struct.pack(">H", value)


def both_endian32(value):
    return struct.pack("<I", value) + struct.pack(">I", value)


def dir_record(name, extent, size, is_dir):
    """One ISO9660 directory record (ECMA-119 9.1)."""
    if is_dir:
        raw = b"\x00" if name == "." else b"\x01"
    else:
        raw = name.encode("ascii")
    length = 33 + len(raw)
    if length % 2:
        length += 1
    record = bytearray()
    record.append(length)
    record.append(0)                        # extended attribute length
    record += both_endian32(extent)
    record += both_endian32(size)
    record += bytes(TIMESTAMP)
    record.append(0x02 if is_dir else 0x00)  # file flags
    record.append(0)                        # file unit size
    record.append(0)                        # interleave gap
    record += both_endian16(1)              # volume sequence number
    record.append(len(raw))
    record += raw
    if length > 33 + len(raw):
        record.append(0)
    assert len(record) == length, (len(record), length)
    return bytes(record)


def path_table(extent, big_endian):
    """A path table for a CD whose only directory is the root (ECMA-119 9.4)."""
    record = bytearray()
    record.append(10)                       # record length
    record.append(0)                        # extended attribute length
    record += struct.pack(">I" if big_endian else "<I", extent)
    record += struct.pack(">H" if big_endian else "<H", 1)   # parent directory
    record.append(1)                        # directory identifier length
    record.append(0)                        # identifier: the root directory
    assert len(record) % 2 == 0
    return bytes(record)


def build_iso(loader, kernel, out_path):
    """Write the CD.  Returns (total blocks, list of (name, lba, bytes))."""
    blob = loader.ljust(LOADER_BLOCKS * BLOCK, b"\x00") + kernel
    blob_blocks = (len(blob) + BLOCK - 1) // BLOCK
    total_blocks = LBA_BOOT_IMAGE + blob_blocks
    kernel_lba = LBA_BOOT_IMAGE + LOADER_BLOCKS     # the kernel file in the blob
    total_bytes = total_blocks * BLOCK

    root_dir = bytearray()
    root_dir += dir_record(".", LBA_ROOT, BLOCK, True)
    root_dir += dir_record("..", LBA_ROOT, BLOCK, True)
    root_dir += dir_record("README.TXT;1", LBA_README, len(README_TEXT), False)
    root_dir += dir_record("OPENXISO.IMG;1", LBA_BOOT_IMAGE, len(blob), False)
    root_dir += dir_record("LINUX.BIN;1", kernel_lba, len(kernel), False)
    root_dir += b"\x00" * (BLOCK - len(root_dir))

    pvd = bytearray(BLOCK)
    pvd[0] = 1
    pvd[1:6] = b"CD001"
    pvd[6] = 1
    pvd[8:40] = b"OPENXISO".ljust(32, b" ")
    pvd[40:72] = b"LINUX-6.6-X86_64".ljust(32, b" ")
    pvd[80:88] = both_endian32(total_blocks)
    pvd[120:124] = both_endian16(1)                 # volume set size
    pvd[124:128] = both_endian16(1)                 # volume sequence number
    pvd[128:132] = both_endian16(BLOCK)             # logical block size
    pvd[132:140] = both_endian32(10)                # path table size
    pvd[140:144] = struct.pack("<I", LBA_PATH_L)
    pvd[144:148] = struct.pack("<I", 0)
    pvd[148:152] = struct.pack(">I", LBA_PATH_M)
    pvd[152:156] = struct.pack(">I", 0)
    pvd[156:190] = dir_record(".", LBA_ROOT, BLOCK, True)
    pvd[190:318] = b"OPENXISO".ljust(128, b" ")
    pvd[318:446] = b"OpenxISO guest CD".ljust(128, b" ")
    pvd[446:574] = b"OpenxISO guest CD".ljust(128, b" ")
    pvd[574:702] = b"OPENXISO".ljust(128, b" ")
    pvd[813:830] = b"2026010100000000\x00"
    pvd[830:847] = b"2026010100000000\x00"
    pvd[847:864] = b"0000000000000000\x00"
    pvd[864:881] = b"0000000000000000\x00"
    pvd[881] = 1                                    # file structure version

    boot_record = bytearray(BLOCK)
    boot_record[0] = 0
    boot_record[1:6] = b"CD001"
    boot_record[6] = 1
    boot_record[7:39] = b"EL TORITO SPECIFICATION".ljust(32, b"\x00")
    boot_record[39:71] = b"OpenxISO".ljust(32, b"\x00")
    boot_record[71:75] = struct.pack("<I", LBA_CATALOG)

    terminator = bytearray(BLOCK)
    terminator[0] = 255
    terminator[1:6] = b"CD001"
    terminator[6] = 1

    catalog = bytearray(BLOCK)
    catalog[0] = 0x01                               # validation entry
    catalog[1] = 0x00                               # platform: x86
    catalog[4:28] = b"OpenxISO".ljust(24, b"\x00")
    catalog[30:32] = b"\x55\xaa"                    # key bytes
    checksum = (-sum(struct.unpack("<16H", catalog[0:32]))) & 0xFFFF
    catalog[28:30] = struct.pack("<H", checksum)
    catalog[32] = 0x88                              # default entry: bootable
    catalog[33] = 0x00                              # no emulation
    catalog[34:36] = struct.pack("<H", 0x0000)      # load segment 0 -> 0x7c00
    catalog[36] = 0x00                              # system type
    catalog[38:40] = struct.pack("<H", LOADER_BLOCKS * BLOCK // SECTOR)
    catalog[40:44] = struct.pack("<I", LBA_BOOT_IMAGE)

    blocks = [
        ("system area", b"\x00" * (16 * BLOCK)),
        ("primary volume descriptor", bytes(pvd)),
        ("boot record", bytes(boot_record)),
        ("terminator", bytes(terminator)),
        ("boot catalog", bytes(catalog)),
        ("root directory", bytes(root_dir)),
        ("path table", path_table(LBA_ROOT, False)),
        ("path table (big endian)", path_table(LBA_ROOT, True)),
        ("readme", README_TEXT.ljust(README_BLOCKS * BLOCK, b"\x00")),
        ("boot image", blob),
    ]

    with open(out_path, "wb") as f:
        written = 0
        for name, data in blocks:
            data = data + b"\x00" * ((-len(data)) % BLOCK)
            f.write(data)
            written += len(data)
        if written != total_bytes:
            raise SystemExit("error: ISO size mismatch (%d != %d)" % (written, total_bytes))

    return total_blocks, [
        ("README.TXT", LBA_README, len(README_TEXT)),
        ("OPENXISO.IMG", LBA_BOOT_IMAGE, len(blob)),
        ("LINUX.BIN", kernel_lba, len(kernel)),
    ]


def checksum(path):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kernel", default=DEFAULT_KERNEL)
    parser.add_argument("--out", default=DEFAULT_OUT)
    parser.add_argument("--check", action="store_true",
                        help="fail if the ISO in --out is not what this produces")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    if not os.path.exists(args.kernel):
        raise SystemExit("error: no kernel image at %s (tools/linux-guest/build.py "
                         "writes it)" % args.kernel)
    with open(args.kernel, "rb") as f:
        kernel = f.read()

    with tempfile.TemporaryDirectory() as tmp:
        loader = assemble_loader(tmp)
        out_path = args.out
        if args.check:
            out_path = os.path.join(tmp, "linux-6.6-x86_64.iso")
        blocks, files = build_iso(loader, kernel, out_path)

        if args.check:
            if not os.path.exists(args.out):
                print("%s does not exist; run tools/linux-guest/mkiso.py" % args.out)
                return 1
            wanted = checksum(out_path)
            actual = checksum(args.out)
            if wanted != actual:
                print("the ISO in %s is not what the sources produce" % args.out)
                print("  built now:         %s" % wanted)
                print("  in the repository: %s" % actual)
                print("run: python3 tools/linux-guest/mkiso.py")
                return 1
            if not args.quiet:
                print("%s is up to date (sha256 %s)" % (args.out, actual))
            return 0

        if args.quiet:
            return 0
        print("loader:            %d bytes (one CD block, %d free)"
              % (len(loader), LOADER_BLOCKS * BLOCK - len(loader)))
        print("kernel:            %s (%d bytes)" % (args.kernel, len(kernel)))
        print("ISO:               %s (%d bytes, %d blocks)"
              % (args.out, os.path.getsize(args.out), blocks))
        print("El Torito entry:   block %d, no emulation, loaded at 0x%x"
              % (LBA_BOOT_IMAGE, LOADER_BASE))
        for name, lba, size in files:
            print("  %-15s block %-5d %9d bytes" % (name, lba, size))
        print("sha256:            %s" % checksum(args.out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
