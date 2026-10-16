#!/usr/bin/env python3
"""The (small) set of source patches the guest kernel build needs here.

None of these change what the kernel *does* at runtime; they deal with the fact
that the machine that builds the image has no bison, no flex and no libelf, so
the two host tools the kernel's build wants cannot be built:

  * scripts/kconfig/conf   is generated from parser.y and lexer.l  -> bison+flex
  * tools/objtool/objtool  needs libelf (elfutils)                 -> libelf

1. `make syncconfig` (and `make olddefconfig`) run scripts/kconfig/syncconfig.py
   instead of `make -C scripts/kconfig syncconfig`, which would first try to
   build `conf`.  syncconfig.py is a pure-Python stand-in for `conf` built on
   kconfiglib; it writes exactly the files `conf` writes (.config,
   include/config/auto.conf{,.cmd}, include/config/tristate.conf,
   include/generated/autoconf.h and include/generated/rustc_cfg).  build.py
   installs it as scripts/kconfig/syncconfig.py.

2. `make prepare` no longer depends on tools/objtool, and the per-object objtool
   invocations in scripts/Makefile.lib become no-ops (`objtool := true`).
   objtool post-processes object files; without it the compiler's output is used
   unmodified, which is correct, just a little less optimised.

3-4. Because objtool does not actually run, the two features whose whole purpose
   is to have objtool *rewrite* the code it inspects are not claimed: inline
   static calls and uaccess validation.  Both are x86 capabilities
   (`select ... if HAVE_OBJTOOL`), so switching them off here leaves
   CONFIG_HAVE_STATIC_CALL_INLINE and CONFIG_HAVE_UACCESS_VALIDATION unset and
   the generic implementations are used instead.

   CONFIG_OBJTOOL itself has to stay y, though: x86_64 selects HAVE_OBJTOOL
   (`select HAVE_OBJTOOL if X86_64`), and include/linux/objtool.h only defines
   the assembly annotation macros (VALIDATE_UNRET_BEGIN, UNWIND_HINT_*,
   ANNOTATE_*, ...) under CONFIG_OBJTOOL, while x86_64 assembly uses them
   unconditionally - CONFIG_OBJTOOL=n does not even assemble.  Nothing else
   selects OBJTOOL for us, so 3+4 keep HAVE_JUMP_LABEL_HACK/HAVE_NOINSTR_HACK,
   which do select it, and the no-op `objtool` command takes care of the rest.

Every patch is idempotent: applying them twice is a no-op.
"""

# (file, original text, replacement text, why, applied_if)
#
# `applied_if` is what makes the patches idempotent and tolerant: a tree that
# was already patched by hand (or by an older version of this file) is left
# alone, and only a tree that still has the problem is edited.
PATCHES = [
    (
        "Makefile",
        "config: outputmakefile scripts_basic FORCE\n"
        "\t$(Q)$(MAKE) $(build)=scripts/kconfig $@\n"
        "\n"
        "%config: outputmakefile scripts_basic FORCE\n"
        "\t$(Q)$(MAKE) $(build)=scripts/kconfig $@\n",
        "# This build environment has no bison and no flex, so the C kconfig tools\n"
        "# (generated from parser.y and lexer.l) cannot be built.\n"
        "# scripts/kconfig/syncconfig.py is a pure-Python stand-in for 'conf';\n"
        "# see tools/linux-guest/patches.py and kconfshim.py.\n"
        "syncconfig olddefconfig: outputmakefile scripts_basic FORCE\n"
        "\t$(Q)$(PYTHON3) $(srctree)/scripts/kconfig/syncconfig.py --$@\n"
        "\n"
        "config: outputmakefile scripts_basic FORCE\n"
        "\t$(Q)$(MAKE) $(build)=scripts/kconfig $@\n"
        "\n"
        "%config: outputmakefile scripts_basic FORCE\n"
        "\t$(Q)$(MAKE) $(build)=scripts/kconfig $@\n",
        "make syncconfig runs the kconfiglib based syncconfig.py, not conf",
        lambda text: "syncconfig olddefconfig: outputmakefile scripts_basic FORCE" in text,
    ),
    (
        "Makefile",
        "ifdef CONFIG_OBJTOOL\nprepare: tools/objtool\nendif\n",
        "# tools/objtool is not built in this environment (no libelf);\n"
        "# the objtool invocations in scripts/Makefile.lib are no-ops instead.\n",
        "do not try to build tools/objtool",
        lambda text: "prepare: tools/objtool" not in text,
    ),
    (
        "scripts/Makefile.lib",
        "objtool := $(objtree)/tools/objtool/objtool\n",
        "# Patched by tools/linux-guest: objtool cannot be built without libelf, so\n"
        "# the commands that would run it become no-ops.  Without that pass the\n"
        "# compiler's own output is used, which is what the kernel wants when the\n"
        "# objtool-only optimisations are off (see arch/x86/Kconfig below).\n"
        "objtool := true\n",
        "make the objtool invocations harmless",
        lambda text: "objtool := true" in text,
    ),
    (
        "arch/x86/Kconfig",
        "\tselect HAVE_STATIC_CALL_INLINE\t\tif HAVE_OBJTOOL\n",
        "# Patched by tools/linux-guest: objtool does not run, so the capability\n"
        "# whose only purpose is to have objtool rewrite call sites is not claimed.\n"
        "#\tselect HAVE_STATIC_CALL_INLINE\t\tif HAVE_OBJTOOL\n",
        "no inline static calls without objtool",
        lambda text: "#\tselect HAVE_STATIC_CALL_INLINE\t\tif HAVE_OBJTOOL" in text,
    ),
    (
        "arch/x86/Kconfig",
        "\tselect HAVE_UACCESS_VALIDATION\t\tif HAVE_OBJTOOL\n",
        "# Patched by tools/linux-guest: needs objtool, which is not built here.\n"
        "#\tselect HAVE_UACCESS_VALIDATION\t\tif HAVE_OBJTOOL\n",
        "no uaccess validation without objtool",
        lambda text: "#\tselect HAVE_UACCESS_VALIDATION\t\tif HAVE_OBJTOOL" in text,
    ),
]


def apply_kernel_patches(kernel_dir):
    """Apply every patch above to the kernel source tree at kernel_dir."""
    for name, original, replacement, why, applied_if in PATCHES:
        path = kernel_dir / name
        text = path.read_text()
        if applied_if(text):
            print("  already patched: %s (%s)" % (name, why))
            continue
        if original not in text:
            raise SystemExit("patch target not found in %s: %r" % (name, original[:60]))
        path.write_text(text.replace(original, replacement, 1))
        print("  patched %s: %s" % (name, why))
