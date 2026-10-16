#!/usr/bin/env python3
"""A stand-in for the kernel's `scripts/kconfig/conf`, built on kconfiglib.

This build environment has no bison/flex, so the C kconfig tools cannot be
built.  kconfiglib (a complete, pure-Python implementation of the Kconfig
language, including the Linux preprocessor functions such as $(shell,...)) can,
so this script implements the parts of `conf` that a build needs:

    kconfshim.py --syncconfig [Kconfig]      # what `make` runs
    kconfshim.py --olddefconfig [Kconfig]    # `make olddefconfig`
    kconfshim.py --defconfig=FILE [Kconfig]  # `make defconfig`-ish
    kconfshim.py --savedefconfig=FILE [Kconfig]

Outputs, all written relative to the objtree (cwd), and all consistent with
each other:

    $KCONFIG_CONFIG                 (default .config)
    include/config/auto.conf
    include/config/auto.conf.cmd
    include/config/tristate.conf
    include/generated/autoconf.h
    include/generated/rustc_cfg

The C implementation writes every symbol that has the "write" flag set, which
means: all symbols with a prompt, plus symbols without a prompt as long as
their value is not "n"/empty.  That second half matters -- Makefiles read
things like $(CONFIG_FUNCTION_ALIGNMENT) and $(CONFIG_FRAME_WARN) from
auto.conf, and those symbols have no prompt.
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
for cand in (os.environ.get("KCONFIGLIB_PATH"),
             os.path.join(HERE, "kconfiglib"),
             os.path.join(HERE, "..", "kconfiglib"),
             "/tmp/kcl/x"):
    if cand and os.path.exists(os.path.join(cand, "kconfiglib.py")):
        sys.path.insert(0, cand)
        break

import kconfiglib  # noqa: E402


def setup_env():
    """kconfiglib reads the environment like `make` does for $(shell,...)."""
    os.environ.setdefault("srctree", ".")
    os.environ.setdefault("ARCH", "x86")
    os.environ.setdefault("SRCARCH", "x86")
    os.environ.setdefault("SHELL", "/bin/bash")
    os.environ.setdefault("CONFIG_SHELL", "/bin/bash")
    os.environ.setdefault("CC", "gcc")
    os.environ.setdefault("HOSTCC", "gcc")
    os.environ.setdefault("HOSTCXX", "g++")
    os.environ.setdefault("LD", "ld")
    os.environ.setdefault("AR", "ar")
    os.environ.setdefault("NM", "nm")
    os.environ.setdefault("OBJCOPY", "objcopy")
    os.environ.setdefault("OBJDUMP", "objdump")
    os.environ.setdefault("READELF", "readelf")
    os.environ.setdefault("STRIP", "strip")
    os.environ.setdefault("PYTHON3", sys.executable)
    os.environ.setdefault("PERL", "perl")


def rm_file(path):
    try:
        os.unlink(path)
    except OSError:
        pass


def write_if_changed(path, text):
    dirname = os.path.dirname(path)
    if dirname:
        os.makedirs(dirname, exist_ok=True)
    try:
        with open(path) as f:
            if f.read() == text:
                return False
    except OSError:
        pass
    with open(path, "w") as f:
        f.write(text)
    return True


def quote_string(value):
    """escape_string_value() from scripts/kconfig/confdata.c."""
    out = ['"']
    for ch in value:
        if ch in ('"', "\\"):
            out.append("\\")
        out.append(ch)
    out.append('"')
    return "".join(out)


def symbol_lines(sym):
    """The .config / auto.conf / autoconf.h representations of one symbol.

    Returns (config_line, make_line, define_line) with None for "not written".
    """
    if not sym.nodes or not sym.name:
        return None

    name = sym.name
    value = sym.str_value

    if sym.type in (kconfiglib.BOOL, kconfiglib.TRISTATE):
        if value == "y":
            return ("CONFIG_%s=y" % name, "CONFIG_%s=y" % name,
                    "#define CONFIG_%s 1" % name)
        if value == "m":
            return ("CONFIG_%s=m" % name, "CONFIG_%s=m" % name,
                    "#define CONFIG_%s_MODULE 1" % name)
        # 'n': only symbols with a prompt are written out
        if not sym.visibility:
            return None
        line = "# CONFIG_%s is not set" % name
        return (line, line, None)

    if sym.type == kconfiglib.STRING:
        # hidden empty strings are left out entirely, which is what
        # usr/Makefile relies on for $(CONFIG_INITRAMFS_SOURCE)
        if not value and not sym.visibility:
            return None
        return ("CONFIG_%s=%s" % (name, quote_string(value)),
                "CONFIG_%s=%s" % (name, value),   # auto.conf: unquoted
                '#define CONFIG_%s %s' % (name, quote_string(value)))

    # int / hex
    if not value and not sym.visibility:
        return None
    return ("CONFIG_%s=%s" % (name, value),
            "CONFIG_%s=%s" % (name, value),
            "#define CONFIG_%s %s" % (name, value))


def generate(kconf):
    """Build the three text files from one pass over the symbols."""
    version = os.environ.get("KERNELVERSION", "")
    banner = ("# Automatically generated file; DO NOT EDIT.\n"
              "# Linux/x86 %s Kernel Configuration\n#\n" % version)

    config_out = [banner]
    autoconf_out = ["/* Automatically generated file; DO NOT EDIT. */\n"]
    auto_conf_out = []

    for sym in kconf.unique_defined_syms:
        lines = symbol_lines(sym)
        if lines is None:
            continue
        config_line, make_line, define_line = lines
        config_out.append(config_line + "\n")
        auto_conf_out.append(make_line + "\n")
        if define_line:
            autoconf_out.append(define_line + "\n")

    return "".join(config_out), "".join(autoconf_out), "".join(auto_conf_out)


def tristate_conf_text(kconf):
    lines = []
    for sym in kconf.unique_defined_syms:
        if sym.type == kconfiglib.TRISTATE and sym.str_value in ("y", "m"):
            lines.append("CONFIG_%s=%s" % (sym.name, sym.str_value.upper()))
    return "".join(line + "\n" for line in lines)


def auto_conf_cmd_text(kconf, srctree):
    """include/config/auto.conf.cmd: version guard plus the Kconfig deps.

    The version guard is only written when KERNELVERSION is known (i.e. when
    make invoked us); writing it from a stand-alone run with a guessed version
    would make every later `make` bail out.
    """
    deps = sorted(kconf.kconfig_filenames)
    out = ["# SPDX-License-Identifier: GPL-2.0\n"]
    kver = os.environ.get("KERNELVERSION")
    if kver:
        out.append('ifneq "$(KERNELVERSION)" "%s"\n' % kver)
        out.append("$(error Kernel configuration not valid - run 'make prepare' "
                   "in %s to update it)\n" % srctree)
        out.append("endif\n\n")
    out.append("$(objtree)/include/config/auto.conf: \\\n")
    for i, dep in enumerate(deps):
        rel = os.path.relpath(dep, os.path.abspath(srctree))
        cont = " \\\n" if i < len(deps) - 1 else "\n"
        out.append("\t$(srctree)/%s%s" % (rel, cont))
    return "".join(out)


def touch_dep_files(kconf, objtree):
    """Recreate include/config/<SYMBOL> marker files, like conf_touch_deps().

    scripts/fixdep records "$(wildcard include/config/FOO)" dependencies in the
    .cmd files, so these (empty) files are what makes `make` rebuild exactly the
    objects whose configuration changed.  Touching all of them is a superset of
    what the C implementation does and only costs a rebuild after a real change.
    """
    cfgdir = os.path.join(objtree, "include/config")
    os.makedirs(cfgdir, exist_ok=True)
    for sym in kconf.unique_defined_syms:
        if not sym.name or not sym.nodes:
            continue
        with open(os.path.join(cfgdir, sym.name), "w"):
            pass


def sync(kconf, objtree, srctree, config_path, quiet):
    config_text, autoconf_text, auto_conf_text = generate(kconf)

    write_if_changed(config_path, config_text)
    # These must always end up newer than .config, otherwise make would keep
    # re-running syncconfig.
    for path, text in (
        (os.path.join(objtree, "include/config/auto.conf"), auto_conf_text),
        (os.path.join(objtree, "include/config/auto.conf.cmd"),
         auto_conf_cmd_text(kconf, srctree)),
        (os.path.join(objtree, "include/config/tristate.conf"),
         tristate_conf_text(kconf)),
        (os.path.join(objtree, "include/generated/autoconf.h"), autoconf_text),
        # Only used with CONFIG_RUST; keep it present so that make never has to
        # regenerate it through a rule we cannot satisfy.
        (os.path.join(objtree, "include/generated/rustc_cfg"),
         "// generated by kconfshim.py; empty because CONFIG_RUST=n\n"),
    ):
        dirname = os.path.dirname(path)
        if dirname:
            os.makedirs(dirname, exist_ok=True)
        with open(path, "w") as f:
            f.write(text)

    touch_dep_files(kconf, objtree)

    if not quiet:
        sys.stderr.write("  (kconfshim) configuration written to %s\n"
                         % os.path.relpath(config_path, objtree))


def main(argv):
    setup_env()
    mode = None
    defconfig = None
    savedefconfig = None
    quiet = False
    kconfig_file = None
    for arg in argv:
        if arg in ("-s", "--silent"):
            quiet = True
        elif arg.startswith("--defconfig="):
            mode, defconfig = "defconfig", arg.split("=", 1)[1]
        elif arg.startswith("--savedefconfig="):
            mode, savedefconfig = "savedefconfig", arg.split("=", 1)[1]
        elif arg.startswith("--"):
            mode = arg[2:]
        elif arg.startswith("-"):
            pass
        else:
            kconfig_file = arg
    if mode is None:
        sys.stderr.write(__doc__)
        return 1
    kconfig_file = kconfig_file or "Kconfig"

    objtree = os.getcwd()
    srctree = os.environ.get("srctree") or "."
    config_path = os.path.join(objtree,
                               os.environ.get("KCONFIG_CONFIG", ".config"))

    if not os.path.exists(os.path.join(srctree, kconfig_file)) \
            and os.path.exists(kconfig_file):
        kconfig_file = os.path.abspath(kconfig_file)

    kconf = kconfiglib.Kconfig(kconfig_file, warn=False)

    if mode == "defconfig":
        kconf.load_config(defconfig)
    elif mode in ("alldefconfig", "allnoconfig"):
        pass  # defaults / already-nothing
    elif os.path.exists(config_path):
        kconf.load_config(config_path)
    elif mode in ("syncconfig", "olddefconfig"):
        sys.stderr.write("***\n*** Configuration file \"%s\" not found!\n***\n"
                         % config_path)
        return 1

    if savedefconfig:
        kconfiglib.Kconfig.write_min_config(kconf, savedefconfig)
        return 0

    sync(kconf, objtree, srctree, config_path, quiet)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
