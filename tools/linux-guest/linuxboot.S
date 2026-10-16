/*
 * The boot loader that starts the guest kernel from a CD.
 *
 * tools/linux-guest/mkiso.py puts two things into the ISO it builds: this
 * program in the first 2048 byte block of the El Torito (no emulation) entry,
 * and the kernel image right behind it.  SeaBIOS loads the whole entry at
 * 0x7c00 and jumps here with DL = the CD drive number, so this is the only code
 * between the BIOS and the kernel: everything the boot protocol in
 * Documentation/x86/boot.rst asks a boot loader to do, and nothing else.
 *
 * It is a real mode loader on purpose.  The kernel's own 16-bit entry point
 * (start_of_setup, at offset 0x200 of the real mode part - the entry point the
 * kernel's boot sector uses) does the hard part itself: it calls the BIOS for
 * the memory map, builds a GDT and page tables, switches to long mode and
 * decompresses the kernel.  A boot loader only has to put the pieces where that
 * code expects them:
 *
 *   - the real mode part (setup_sects + 1 sectors, 14848 bytes in this image)
 *     at 0x80000.  It contains the header the kernel reads its own parameters
 *     from, so the header fields a loader is responsible for are patched there:
 *     type_of_loader, loadflags (CAN_USE_HEAP) and the video mode (0xffff
 *     leaves the current one alone);
 *   - the protected mode part (the decompressor and the compressed kernel) at
 *     0x100000;
 *   - the command line at 0x8e000, with cmd_line_ptr pointing at it and
 *     heap_end_ptr advertising the space below it as free - the same layout the
 *     emulator's own bzImage loader uses (emulator/vendor/v86_64/src/kernel.js),
 *     so the kernel sees exactly what it sees when the page boots the kernel
 *     file directly.
 *
 * Where the image is, this loader finds out from the ISO itself, so the CD can
 * be laid out any way an ISO writer would lay it out: read the boot record
 * (absolute block 17), take the address of the boot catalog from it, read the
 * catalog, take the address of the boot image from it - and the kernel starts
 * one block after the image, because this program is the first block of it.
 *
 * Reading and moving: the BIOS reads with INT 13h AH=42h, which addresses a CD
 * in 2048 byte blocks (that is the block size SeaBIOS reports for a CD) into
 * whatever segment:offset it is given.  No segment register can address memory
 * above 0xffff0, so reads go into a 64 KiB scratch buffer at 0x10000 (the
 * classic scratch area) and are then copied up with INT 15h AH=87h, "move
 * extended memory block": the way a real mode program moves memory above 1 MiB
 * without leaving real mode.
 *
 * Assembled by mkiso.py (cpp, as and ld - binutils only, like boot64.S):
 *     cpp -P linuxboot.S linuxboot.s
 *     as --64 linuxboot.s -o linuxboot.o
 *     ld -m elf_x86_64 -Ttext 0x7c00 -e _start --oformat binary \
 *        linuxboot.o -o linuxboot.bin
 *
 * The binary has to fit in one 2048 byte block: mkiso.py refuses to build the
 * ISO otherwise, because the kernel has to start on a block boundary for the
 * ISO9660 directory entry that points at it.
 */

#define BOUNCE_SEG      0x1000      /* 0x10000: where the BIOS reads into */
#define STACK_TOP       0x1000      /* our stack, below the scratch area */
#define DESC_TABLE      0x0600      /* INT 15h AH=87h descriptor table, 6 * 8 */
#define DAP             0x0640      /* INT 13h AH=42h disk address packet */
#define DESC_TABLE_SIZE 0x30        /* 6 descriptors, as the BIOS expects */

#define SETUP_SEG       0x8000      /* the kernel's real mode part: 0x80000 */
#define SETUP_ENTRY     0x0200      /* start_of_setup, offset of the entry */
#define CMDLINE_OFF     0xE000      /* 0x8000:0xe000 = 0x8e000 (linear) */
#define KERNEL_HIGH     0x100000    /* the protected mode part */
#define BOOT_RECORD_LBA 17          /* the ISO9660 boot record descriptor */

#define BLOCK           2048        /* the CD's block size, and the ISO's */
#define CHUNK_BLOCKS    32          /* 64 KiB per INT 13h call (its limit) */
#define MAX_SETUP_BLOCKS 32         /* the real mode part fits the scratch area */

#define SERIAL_PORT     0x03f8

        .code16
        .text

        .global _start
_start:
        cli
        cld
        xorw    %ax, %ax
        movw    %ax, %ds
        movw    %ax, %es
        movw    %ax, %ss
        movw    $STACK_TOP, %sp
        movb    %dl, boot_drive

        /* The BIOS reads these tables, and the code below only fills in the
         * fields it has to: the reserved part has to start out as zero. */
        movw    $DESC_TABLE, %di
        movw    $(DESC_TABLE_SIZE), %cx
        xorw    %ax, %ax
        rep stosb
        movb    $0x10, DAP + 0                /* DAP: size of the packet, */
        movb    $0x00, DAP + 1                /* reserved (both static) */

        movw    $msg_banner, %si
        call    serial_string

        /* The boot record tells us where the boot catalog is. */
        movl    $BOOT_RECORD_LBA, bounce_lba
        movw    $1, bounce_count
        call    read_blocks
        movw    $BOUNCE_SEG, %ax
        movw    %ax, %es
        movl    %es:0x47, %eax
        movl    %eax, %ebx
        shrl    $24, %ebx
        testl   %ebx, %ebx
        jnz     no_boot_record
        orl     %eax, %eax
        jz      no_boot_record
        movl    %eax, bounce_lba

        /* ... and the catalog tells us where the boot image is. */
        movw    $1, bounce_count
        call    read_blocks
        movw    $BOUNCE_SEG, %ax
        movw    %ax, %es
        cmpb    $0x01, %es:0x00
        jne     no_boot_catalog
        cmpb    $0x00, %es:0x01
        jne     no_boot_catalog
        cmpb    $0x88, %es:0x20
        jne     no_boot_catalog
        cmpb    $0x55, %es:0x1e
        jne     no_boot_catalog
        cmpb    $0xaa, %es:0x1f
        jne     no_boot_catalog
        movl    %es:0x28, %eax
        movl    %eax, %ebx
        shrl    $24, %ebx
        testl   %ebx, %ebx
        jnz     no_boot_catalog
        /* the kernel is the second block of the boot image */
        addl    $1, %eax
        movl    %eax, kernel_lba

        movw    $msg_image, %si
        call    serial_string
        movl    kernel_lba, %eax
        call    serial_hex32

        /* Read the kernel's first block and look at its header: the whole
         * layout of the image is in there (setup_sects, syssize). */
        movl    kernel_lba, %eax
        movl    %eax, bounce_lba
        movw    $1, bounce_count
        call    read_blocks
        movw    $BOUNCE_SEG, %ax
        movw    %ax, %es
        cmpw    $0xaa55, %es:0x1fe
        jne     no_kernel
        cmpl    $0x53726448, %es:0x202         /* "HdrS" */
        jne     no_kernel

        movzbl  %es:0x1f1, %eax                /* setup_sects */
        addl    $1, %eax
        shll    $9, %eax                       /* (setup_sects + 1) * 512 */
        movl    %eax, setup_bytes
        movl    %es:0x1f4, %edx                /* syssize, in 16 byte units */
        shll    $4, %edx
        movl    %edx, prot_bytes
        addl    %eax, %edx                     /* the whole image */
        movl    %edx, total_bytes
        /* blocks_total = ceil(total_bytes / 2048) */
        addl    $(BLOCK - 1), %edx
        shrl    $11, %edx
        movw    %dx, blocks_total
        /* the real mode part first, in one piece */
        movl    setup_bytes, %eax
        addl    $(BLOCK - 1), %eax
        shrl    $11, %eax
        movw    %ax, first_blocks
        cmpw    $MAX_SETUP_BLOCKS, %ax
        ja      setup_too_large

        movw    $msg_setup, %si
        call    serial_string
        movl    setup_bytes, %eax
        call    serial_hex32
        movw    $msg_prot, %si
        call    serial_string
        movl    prot_bytes, %eax
        call    serial_hex32
        call    serial_crlf

        movl    kernel_lba, %eax
        movl    %eax, bounce_lba
        movzwl  first_blocks, %eax
        movw    %ax, bounce_count
        call    read_blocks
        /* the real mode part goes to 0x80000 ... */
        movl    $BOUNCE_SEG << 4, %eax
        movl    %eax, copy_src
        movl    $SETUP_SEG << 4, %eax
        movl    %eax, copy_dst
        movl    setup_bytes, %eax
        shrl    $1, %eax                       /* words (the part is even) */
        movw    %ax, copy_words
        call    copy_high
        /* ... and the rest of that first read is the start of the protected
         * mode part, which goes to 0x100000. */
        movzwl  first_blocks, %eax
        shll    $11, %eax
        movl    %eax, %edx
        subl    setup_bytes, %edx              /* bytes after the setup part */
        movl    %edx, copied
        movl    $KERNEL_HIGH, %eax
        addl    %edx, %eax
        movl    %eax, dest
        testl   %edx, %edx
        jz      first_done
        movl    $BOUNCE_SEG << 4, %eax
        addl    setup_bytes, %eax
        movl    %eax, copy_src
        movl    dest, %eax
        subl    %edx, %eax                     /* = KERNEL_HIGH */
        movl    %eax, copy_dst
        movl    %edx, %eax
        shrl    $1, %eax
        movw    %ax, copy_words
        call    copy_high
first_done:
        movw    first_blocks, %ax
        movw    %ax, next_block

        /* Everything else is read in 64 KiB chunks: the BIOS reads into the
         * scratch buffer, INT 15h AH=87h copies the chunk up. */
copy_loop:
        movw    next_block, %ax
        cmpw    blocks_total, %ax
        jae     copy_done
        movw    blocks_total, %bx
        subw    %ax, %bx
        cmpw    $CHUNK_BLOCKS, %bx
        jbe     chunk_ok
        movw    $CHUNK_BLOCKS, %bx
chunk_ok:
        movl    kernel_lba, %eax
        movzwl  next_block, %edx
        addl    %edx, %eax
        movl    %eax, bounce_lba
        movw    %bx, bounce_count
        movw    %bx, this_chunk
        call    read_blocks

        movl    $BOUNCE_SEG << 4, %eax
        movl    %eax, copy_src
        movl    dest, %eax
        movl    %eax, copy_dst
        /* bytes = min(chunk * 2048, total - copied) */
        movzwl  this_chunk, %eax
        shll    $11, %eax
        movl    total_bytes, %edx
        subl    copied, %edx
        cmpl    %edx, %eax
        jbe     chunk_size_ok
        movl    %edx, %eax
chunk_size_ok:
        addl    %eax, copied
        addl    %eax, dest
        shrl    $1, %eax
        movw    %ax, copy_words
        call    copy_high

        movw    this_chunk, %ax
        addw    %ax, next_block
        jmp     copy_loop
copy_done:
        /* The kernel reads its own header from the copy at 0x80000, so that is
         * where the loader's fields have to be. */
        movw    $SETUP_SEG, %ax
        movw    %ax, %es
        movb    $0xff, %es:0x210               /* type_of_loader: undefined */
        movb    $0x81, %es:0x211               /* LOADED_HIGH | CAN_USE_HEAP */
        movw    $0xde00, %es:0x224             /* heap ends at 0x8e000 */
        movl    $CMDLINE_OFF + (SETUP_SEG << 4), %eax
        movl    %eax, %es:0x228                /* cmd_line_ptr */
        movw    $0xffff, %es:0x1fa             /* video mode: leave it alone */

        /* the command line itself, in the same segment */
        movw    $CMDLINE_OFF, %di
        movw    $cmdline, %si
cmdline_copy:
        lodsb
        stosb
        testb   %al, %al
        jnz     cmdline_copy

        movw    $msg_boot, %si
        call    serial_string
        movzwl  blocks_total, %eax
        call    serial_hex32
        movw    $msg_bytes, %si
        call    serial_string
        movl    total_bytes, %eax
        call    serial_hex32
        movw    $msg_bytes_unit, %si
        call    serial_string
        call    serial_crlf

        /* Hand over the way the emulator's own loader does: the kernel's real
         * mode part runs with CS = DS = ES = SS = 0x8000 and a stack at the end
         * of the free space below the command line. */
        movw    $SETUP_SEG, %ax
        movw    %ax, %ds
        movw    %ax, %es
        movw    %ax, %fs
        movw    %ax, %gs
        movw    %ax, %ss
        movw    $CMDLINE_OFF, %sp
        cli
        cld
        ljmp    $SETUP_SEG, $SETUP_ENTRY

/* ------------------------------------------------------------------ */
/* Reading blocks from the CD (INT 13h, IBM/MS extended read)          */
/* ------------------------------------------------------------------ */

/*
 * Read bounce_count 2048 byte blocks starting at bounce_lba into
 * BOUNCE_SEG:0.  Every register is reloaded from memory on every attempt
 * because the BIOS is allowed to change them, and a failed read means there is
 * no kernel to boot: three attempts, with a drive reset in between, and then
 * the error is printed and the machine stops.
 */
read_blocks:
        movw    $3, retries
read_attempt:
        xorw    %ax, %ax
        movw    %ax, %ds
        movw    bounce_count, %ax
        movw    %ax, DAP + 2
        movw    $0, DAP + 4
        movw    $BOUNCE_SEG, DAP + 6
        movl    bounce_lba, %eax
        movl    %eax, DAP + 8
        movl    $0, DAP + 12
        movb    boot_drive, %dl
        movw    $DAP, %si
        movw    $0x4200, %ax
        int     $0x13
        jnc     read_done
        movb    %ah, last_error
        movb    boot_drive, %dl
        xorw    %ax, %ax
        int     $0x13
        decw    retries
        jnz     read_attempt
        movw    $msg_read_error, %si
        call    serial_string
        movl    bounce_lba, %eax
        call    serial_hex32
        movb    $0x20, %al
        call    serial_byte
        movzwl  bounce_count, %eax
        call    serial_hex32
        movb    $0x20, %al
        call    serial_byte
        movb    last_error, %al
        call    serial_hex8
        call    serial_crlf
        jmp     hang

read_done:
        xorw    %ax, %ax
        movw    %ax, %ds
        movw    %ax, %es
        ret

/* ------------------------------------------------------------------ */
/* Copying above 1 MiB (INT 15h, move extended memory block)           */
/* ------------------------------------------------------------------ */

/*
 * copy_words words from copy_src to copy_dst, both linear addresses.  The BIOS
 * wants a GDT-like descriptor table with a source and a destination descriptor
 * (offset 0x10 and 0x18; the BIOS fills in the rest) and the count in words.
 */
copy_high:
        xorw    %ax, %ax
        movw    %ax, %ds
        movw    %ax, %es

        movw    copy_words, %cx
        movw    %cx, %bx
        decw    %bx
        movw    %bx, DESC_TABLE + 0x10         /* limit */
        movl    copy_src, %eax
        movw    %ax, DESC_TABLE + 0x12         /* base 15:0 */
        movl    %eax, %ebx
        shrl    $16, %ebx
        movb    %bl, DESC_TABLE + 0x14         /* base 23:16 */
        movb    $0x93, DESC_TABLE + 0x15       /* present, data, read/write */
        movb    $0x00, DESC_TABLE + 0x16       /* byte granularity, 16 bit */
        shrl    $8, %ebx
        movb    %bl, DESC_TABLE + 0x17         /* base 31:24 */

        movw    copy_words, %bx
        decw    %bx
        movw    %bx, DESC_TABLE + 0x18
        movl    copy_dst, %edx
        movw    %dx, DESC_TABLE + 0x1a
        movl    %edx, %ebx
        shrl    $16, %ebx
        movb    %bl, DESC_TABLE + 0x1c
        movb    $0x93, DESC_TABLE + 0x1d
        movb    $0x00, DESC_TABLE + 0x1e
        shrl    $8, %ebx
        movb    %bl, DESC_TABLE + 0x1f

        movw    $DESC_TABLE, %si
        movw    $0x8700, %ax
        int     $0x15
        jc      memory_error

        xorw    %ax, %ax
        movw    %ax, %ds
        movw    %ax, %es
        ret

memory_error:
        movw    $msg_memory_error, %si
        call    serial_string
        movb    %ah, %al
        call    serial_hex8
        call    serial_crlf
        jmp     hang

/* ------------------------------------------------------------------ */
/* Reporting over COM1 (what the tests watch)                          */
/* ------------------------------------------------------------------ */

serial_string:
        pushw   %ax
        pushw   %ds
        xorw    %ax, %ax
        movw    %ax, %ds
next_serial_char:
        lodsb
        testb   %al, %al
        jz      serial_string_done
        call    serial_byte
        jmp     next_serial_char
serial_string_done:
        popw    %ds
        popw    %ax
        ret

serial_byte:
        pushw   %ax
        pushw   %dx
        movw    $SERIAL_PORT, %dx
        outb    %al, %dx
        popw    %dx
        popw    %ax
        ret

serial_crlf:
        pushw   %ax
        movb    $0x0d, %al
        call    serial_byte
        movb    $0x0a, %al
        call    serial_byte
        popw    %ax
        ret

/* Print %al as two hex digits. */
serial_hex8:
        pushw   %ax
        pushw   %ax
        shrb    $4, %al
        call    serial_nibble
        popw    %ax
        andb    $0x0f, %al
        call    serial_nibble
        popw    %ax
        ret

/* Print %eax as eight hex digits. */
serial_hex32:
        pushl   %eax
        pushl   %eax
        shrl    $16, %eax
        call    serial_hex16
        popl    %eax
        call    serial_hex16
        popl    %eax
        ret

/* Print %ax as four hex digits. */
serial_hex16:
        pushw   %ax
        pushw   %ax
        movb    %ah, %al
        call    serial_hex8
        popw    %ax
        call    serial_hex8
        popw    %ax
        ret

serial_nibble:
        andb    $0x0f, %al
        cmpb    $10, %al
        jb      serial_nibble_digit
        addb    $('a' - 10), %al
        jmp     serial_byte
serial_nibble_digit:
        addb    $'0', %al
        jmp     serial_byte

hang:
        cli
        hlt
        jmp     hang

no_boot_record:
        movw    $msg_no_boot_record, %si
        call    serial_string
        jmp     hang

no_boot_catalog:
        movw    $msg_no_boot_catalog, %si
        call    serial_string
        jmp     hang

no_kernel:
        movw    $msg_no_kernel, %si
        call    serial_string
        jmp     hang

setup_too_large:
        movw    $msg_setup_too_large, %si
        call    serial_string
        jmp     hang

/* ------------------------------------------------------------------ */
/* State, strings and tables                                           */
/* ------------------------------------------------------------------ */

msg_banner:
        .asciz  "openxiso linux boot loader (El Torito, no emulation)\r\n"
msg_image:
        .asciz  "kernel at CD block "
msg_setup:
        .asciz  "real mode part "
msg_prot:
        .asciz  " bytes, protected mode part "
msg_boot:
        .asciz  "booting "

msg_bytes:
        .asciz  " blocks, "
msg_bytes_unit:
        .asciz  " bytes"
msg_read_error:
        .asciz  "CD read failed: lba "
msg_memory_error:
        .asciz  "move to extended memory failed: "
msg_no_boot_record:
        .asciz  "no ISO9660 boot record\r\n"
msg_no_boot_catalog:
        .asciz  "no El Torito boot catalog\r\n"
msg_no_kernel:
        .asciz  "no kernel image in the boot image\r\n"
msg_setup_too_large:
        .asciz  "the real mode part does not fit the scratch area\r\n"
cmdline:
        /* Nearly the same command line the emulator passes when the kernel is
         * booted as a file - plus "ro", which is what a boot loader normally
         * passes and what the test uses to tell the two apart (this one really
         * came from here: the kernel prints it as its command line). */
        .asciz  "console=tty0 console=ttyS0,115200 ro"

boot_drive:
        .byte   0
last_error:
        .byte   0
retries:
        .word   0
bounce_lba:
        .long   0
bounce_count:
        .word   0
kernel_lba:
        .long   0
setup_bytes:
        .long   0
prot_bytes:
        .long   0
total_bytes:
        .long   0
copied:
        .long   0
dest:
        .long   0
blocks_total:
        .word   0
first_blocks:
        .word   0
next_block:
        .word   0
this_chunk:
        .word   0
copy_src:
        .long   0
copy_dst:
        .long   0
copy_words:
        .word   0
