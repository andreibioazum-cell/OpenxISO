#!/usr/bin/env python3
"""Build the real 64-bit Linux guest image that the emulator demo boots.

What comes out (in emulator/images by default, and that is what the app, the
tests and the documentation use):

    linux-6.6-x86_64.bzImage    Linux 6.6 for x86-64 with a BusyBox initramfs
                                built into the image; booted through the Linux
                                boot protocol, no BIOS or boot sector involved
    linux-6.6-x86_64.initramfs.cpio  the same initramfs as a standalone archive
    linux-6.6-x86_64.config     the exact configuration the kernel was built with
    linux-6.6-x86_64.manifest   hashes, versions and provenance

Everything is built from upstream sources plus the small, documented
build-environment patches in patches.py (this machine has no bison, no flex and
no libelf, so the kernel's `conf` and objtool cannot be built - see that file):

    https://codeload.github.com/torvalds/linux/tar.gz/refs/tags/v6.6
    https://codeload.github.com/mirror/busybox/tar.gz/refs/tags/1_36_1

The configuration started as the hand-written config.fragment; `make syncconfig`
(patched to run the kconfiglib based scripts/kconfig/syncconfig.py) turns it into
a complete .config, and that is what ends up next to the image.

    python3 tools/linux-guest/build.py                  # ~10 min on 2 cores
    python3 tools/linux-guest/build.py --jobs 8
    python3 tools/linux-guest/build.py --out-dir /tmp/guest-images
    python3 tools/linux-guest/build.py --kernel-only    # skip busybox

The downloads are cached in the work directory, so a rebuild after a source
change is quick.
"""

import argparse
import hashlib
import os
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent

KERNEL_VERSION = "6.6"
KERNEL_TAG = "v6.6"
KERNEL_URL = "https://codeload.github.com/torvalds/linux/tar.gz/refs/tags/%s" % KERNEL_TAG
BUSYBOX_VERSION = "1.36.1"
BUSYBOX_TAG = "1_36_1"
BUSYBOX_URL = "https://codeload.github.com/mirror/busybox/tar.gz/refs/tags/%s" % BUSYBOX_TAG

NAME = "linux-%s-x86_64" % KERNEL_VERSION
CMDLINE = "console=tty0 console=ttyS0,115200"

# Symbols the finished .config must have, as a safety net: they are the ones
# that make the difference between "a kernel that boots in the emulator" and a
# kernel that has no console, no userland or no working CPU model.  The values
# are checked after `make syncconfig` ran.
EXPECTED_CONFIG = [
    "CONFIG_64BIT=y",
    "CONFIG_X86_64=y",
    "CONFIG_SERIAL_8250=y",
    "CONFIG_SERIAL_8250_CONSOLE=y",
    "CONFIG_BLK_DEV_INITRD=y",
    "CONFIG_RD_GZIP=y",
    "CONFIG_VT=y",
    "CONFIG_VGA_CONSOLE=y",
    "CONFIG_BINFMT_ELF=y",
    "CONFIG_DEVTMPFS=y",
    "CONFIG_OBJTOOL=y",              # the asm annotation macros need this
    "CONFIG_MODULES=n",
]


def log(msg):
    sys.stdout.write("[linux-guest] %s\n" % msg)
    sys.stdout.flush()


def run(cmd, cwd=None, env=None, log_path=None, check=True):
    """Run a command, echoing it and optionally appending its output to a log."""
    log("$ " + " ".join(str(part) for part in cmd))
    out = None
    if log_path:
        out = open(log_path, "ab")
        out.write(("\n\n===== %s =====\n" % " ".join(str(part) for part in cmd)).encode())
        out.flush()
    try:
        proc = subprocess.run(cmd, cwd=cwd, env=env, stdout=out or None,
                              stderr=subprocess.STDOUT if out else None)
    finally:
        if out:
            out.close()
    if check and proc.returncode != 0:
        raise SystemExit("[linux-guest] command failed (%d): %s"
                         % (proc.returncode, " ".join(str(part) for part in cmd)))
    return proc.returncode


def download(url, dest):
    if dest.exists() and dest.stat().st_size > 0:
        log("cached: %s (%d bytes)" % (dest.name, dest.stat().st_size))
        return dest
    log("downloading %s" % url)
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(url) as src, open(tmp, "wb") as dst:
        shutil.copyfileobj(src, dst, 1 << 20)
    tmp.rename(dest)
    log("  -> %s (%d bytes)" % (dest.name, dest.stat().st_size))
    return dest


def extract(tarball, dest, strip=1):
    if dest.exists() and any(dest.iterdir()):
        log("already extracted: %s" % dest)
        return dest
    dest.mkdir(parents=True, exist_ok=True)
    log("extracting %s" % tarball.name)
    with tarfile.open(tarball) as tar:
        members = []
        for member in tar.getmembers():
            parts = Path(member.name).parts
            if len(parts) <= strip:
                continue
            member.name = str(Path(*parts[strip:]))
            members.append(member)
        tar.extractall(dest, members=members)
    return dest


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def host_env(shim):
    """The environment the kernel build runs with: our bc first, kconfiglib."""
    env = dict(os.environ)
    env["PATH"] = "%s%s%s" % (shim, os.pathsep, env.get("PATH", ""))
    env["KCONFIGLIB_PATH"] = str(HERE / "kconfiglib")
    env["KBUILD_BUILD_TIMESTAMP"] = env.get("KBUILD_BUILD_TIMESTAMP", "")
    return env


def prepare_kernel(work, kernel_dir, tarball):
    """Extract and patch the kernel tree, and install the host tool shims."""
    if (kernel_dir / ".openxiso-patched").exists():
        log("kernel tree already patched")
    else:
        extract(tarball, kernel_dir)
        from patches import apply_kernel_patches  # same directory
        apply_kernel_patches(kernel_dir)
        shutil.copy2(HERE / "kconfshim.py", kernel_dir / "scripts/kconfig/syncconfig.py")
        (kernel_dir / ".openxiso-patched").write_text("patched by tools/linux-guest\n")

    shim = work / "host-bin"
    shim.mkdir(parents=True, exist_ok=True)
    shutil.copy2(HERE / "bc", shim / "bc")
    os.chmod(shim / "bc", 0o755)
    return shim


def write_kernel_config(kernel_dir, initramfs_dir, shim):
    """Turn config.fragment into a complete .config via `make syncconfig`.

    The initramfs paths cannot live in the fragment (they depend on the work
    directory), so they are appended here: one source is the assembled tree and
    the other is the list of device nodes to create (the build user is not root,
    so the nodes cannot exist in the tree itself).
    """
    fragment = (HERE / "config.fragment").read_text()
    fragment += (
        "\n# appended by tools/linux-guest/build.py: the initramfs to embed\n"
        'CONFIG_INITRAMFS_SOURCE="%s %s"\n' % (initramfs_dir, HERE / "initramfs.devices")
    )
    (kernel_dir / ".config").write_text(fragment)

    log("resolving the configuration with make syncconfig")
    run(["make", "syncconfig"], cwd=kernel_dir, env=host_env(shim),
        log_path=kernel_dir.parent / "config.log")

    config = {}
    for line in (kernel_dir / ".config").read_text().splitlines():
        if line.startswith("CONFIG_") and "=" in line:
            name, _, value = line.partition("=")
            config[name] = value
    missing = [want for want in EXPECTED_CONFIG
               if config.get(want.split("=")[0]) != want.split("=", 1)[1]]
    if missing:
        raise SystemExit("[linux-guest] the resulting .config is missing: %s"
                         % ", ".join(missing))
    if str(initramfs_dir) not in config.get("CONFIG_INITRAMFS_SOURCE", ""):
        raise SystemExit("[linux-guest] CONFIG_INITRAMFS_SOURCE did not take")
    if not config.get("CONFIG_CC_VERSION_TEXT", "").strip('"'):
        raise SystemExit("[linux-guest] CONFIG_CC_VERSION_TEXT is empty; the "
                         "build ran without a compiler in the environment")
    log("configuration resolved (%d options, compiler %s)"
        % (len(config), config["CONFIG_CC_VERSION_TEXT"]))


def build_busybox(work, initramfs_dir, tarball, jobs):
    """Build a static busybox and install it into the initramfs tree."""
    bb_src = work / "busybox-%s" % BUSYBOX_VERSION
    extract(tarball, bb_src)

    config = bb_src / ".config"
    if not config.exists():
        run(["make", "defconfig"], cwd=bb_src, log_path=work / "busybox.log")
    text = config.read_text()
    unknown = []
    for line in (HERE / "busybox.fragment").read_text().splitlines():
        name = line.strip()
        if not name or name.startswith("#"):
            continue
        if "# %s is not set" % name in text:
            text = text.replace("# %s is not set" % name, "%s=y" % name, 1)
        elif "%s=y" % name in text:
            pass  # already on
        else:
            unknown.append(name)
    config.write_text(text)
    for name in unknown:
        log("  note: %s is not a boolean option of this busybox, skipped" % name)

    if not (bb_src / "busybox").exists():
        run(["make", "-j%d" % jobs], cwd=bb_src, log_path=work / "busybox.log")
    else:
        log("busybox already built")

    if not (bb_src / "busybox").exists():
        raise SystemExit("[linux-guest] busybox was not built")
    log("busybox: %d bytes (%s)" % ((bb_src / "busybox").stat().st_size,
                                    "static" if "CONFIG_STATIC=y" in text else "dynamic"))

    # the skeleton comes from the repository, busybox is installed on top of it
    if initramfs_dir.exists():
        shutil.rmtree(initramfs_dir)
    shutil.copytree(HERE / "initramfs", initramfs_dir, symlinks=True)
    run(["make", "CONFIG_PREFIX=%s" % initramfs_dir, "install"],
        cwd=bb_src, log_path=work / "busybox.log")
    return initramfs_dir


def build_kernel(kernel_dir, shim, jobs):
    started = time.time()
    run(["make", "-j%d" % jobs, "bzImage"], cwd=kernel_dir, env=host_env(shim),
        log_path=kernel_dir.parent / "build.log")
    log("kernel built in %.1f min" % ((time.time() - started) / 60))


def collect(kernel_dir, out_dir, keep_cpio=False):
    out_dir.mkdir(parents=True, exist_ok=True)
    bzimage = kernel_dir / "arch/x86/boot/bzImage"
    cpio = kernel_dir / "usr/initramfs_data.cpio"
    if not bzimage.exists():
        raise SystemExit("[linux-guest] %s is missing" % bzimage)

    shutil.copy2(bzimage, out_dir / (NAME + ".bzImage"))
    if keep_cpio and cpio.exists():
        shutil.copy2(cpio, out_dir / (NAME + ".initramfs.cpio"))
    shutil.copy2(kernel_dir / ".config", out_dir / (NAME + ".config"))

    files = sorted(path for path in out_dir.glob(NAME + ".*"))
    manifest = [
        "OpenxISO 64-bit Linux guest image",
        "=================================",
        "",
        "kernel:    Linux %s (x86-64), from %s" % (KERNEL_VERSION, KERNEL_URL),
        "userland:  BusyBox %s (static, glibc), from %s" % (BUSYBOX_VERSION, BUSYBOX_URL),
        "config:    tools/linux-guest/config.fragment, resolved with make syncconfig",
        "patches:   tools/linux-guest/patches.py (build environment only)",
        "engine:    emulator/vendor/v86_64, booted through the Linux boot protocol",
        "cmdline:   %s" % CMDLINE,
        "",
        "files:",
    ]
    for path in files:
        manifest.append("  %-38s %9d bytes  sha256 %s"
                        % (path.name, path.stat().st_size, sha256(path)))
    (out_dir / (NAME + ".manifest")).write_text("\n".join(manifest) + "\n")

    for path in sorted(out_dir.glob(NAME + ".*")):
        log("  %-38s %9d bytes" % (path.name, path.stat().st_size))


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--work-dir", default="/tmp/openxiso-linux-guest",
                        help="where the downloads and the build tree live")
    parser.add_argument("--out-dir", default=str(REPO / "emulator" / "images"),
                        help="where the finished image goes")
    parser.add_argument("--jobs", type=int, default=os.cpu_count() or 2)
    parser.add_argument("--kernel-only", action="store_true",
                        help="do not build busybox; use the skeleton as it is")
    parser.add_argument("--keep-cpio", action="store_true",
                        help="also write the initramfs archive next to the kernel")
    args = parser.parse_args()

    work = Path(args.work_dir).resolve()
    work.mkdir(parents=True, exist_ok=True)
    kernel_dir = work / ("linux-%s" % KERNEL_VERSION)
    initramfs_dir = work / "initramfs"

    for tool in ("make", "gcc", "ld"):
        if not shutil.which(tool):
            raise SystemExit("[linux-guest] %s is needed to build the kernel" % tool)

    kernel_tarball = download(KERNEL_URL, work / ("linux-%s.tar.gz" % KERNEL_VERSION))
    busybox_tarball = None
    if not args.kernel_only:
        busybox_tarball = download(BUSYBOX_URL, work / ("busybox-%s.tar.gz" % BUSYBOX_VERSION))

    shim = prepare_kernel(work, kernel_dir, kernel_tarball)
    if args.kernel_only:
        if initramfs_dir.exists():
            shutil.rmtree(initramfs_dir)
        shutil.copytree(HERE / "initramfs", initramfs_dir, symlinks=True)
    else:
        build_busybox(work, initramfs_dir, busybox_tarball, args.jobs)
    write_kernel_config(kernel_dir, initramfs_dir, shim)
    build_kernel(kernel_dir, shim, args.jobs)
    collect(kernel_dir, Path(args.out_dir).resolve(), keep_cpio=args.keep_cpio)

    log("done: %s/%s.bzImage boots in the emulator on its own" % (args.out_dir, NAME))


if __name__ == "__main__":
    sys.exit(main())
