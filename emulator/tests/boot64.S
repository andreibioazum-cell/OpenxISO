/*
 * A tiny bootable program used to test the emulator end to end.
 *
 * It is booted two ways by emulator/tests/make_test_images.py:
 *   - as an El Torito (no emulation) boot image of a small ISO9660 CD image,
 *   - as the boot sector of a raw .hdd image (the rest is read with INT 13h).
 *
 * What it does:
 *   1. real mode: prints a banner with BIOS int 10h and COM1,
 *   2. makes sure the continuation (sector 2 onwards) is in memory,
 *   3. enters 32-bit protected mode and builds 4-level page tables for the
 *      first gigabyte (2 MiB pages) at 0x1000/0x2000/0x3000,
 *   4. switches to 64-bit long mode (PAE + LME + CR0.PG),
 *   5. in long mode: prints to COM1, runs 64-bit arithmetic with REX.W ops and
 *      r8-r15, prints the result, writes a banner into the VGA text buffer at
 *      0xB8000 and beeps the PC speaker,
 *   6. halts.
 *
 * Interrupts stay disabled: the program installs no IDT, and the BIOS calls
 * used here work with IF=0 (some BIOS routines set it, so it is cleared again
 * before the mode switches).
 *
 * The emulator test asserts on the COM1 output, so the CPU really has to be in
 * long mode and executing 64-bit code for it to pass.
 *
 * Everything the boot sector needs before it has read the continuation (the
 * strings, the drive number, the loop counters) lives in the first 512 bytes,
 * because on a hard disk boot nothing past 0x7e00 is in memory yet.
 *
 * Assembled by make_test_images.py with a C preprocessor and GNU as:
 *     cpp -P boot64.S boot64.s
 *     as --64 boot64.s -o boot64.o
 *     ld -m elf_x86_64 -Ttext 0x7c00 -e _start --oformat binary boot64.o -o boot64.bin
 *
 * The image is linked as if it were loaded at 0x7c00: the BIOS loads the first
 * sector there, the rest is read to 0x7e00 (HDD boot) or already placed at
 * 0x7e00 by El Torito (CD boot).
 */

#define MAGIC       0x0badc0de
#define DISK_SECTORS 16             /* sectors read on a hard disk boot */

        .code16
        .text

/* The whole image is one .text section; its first 512 bytes are the boot
 * sector / El Torito entry point, the rest is the continuation at 0x7e00. */
        .global _start
_start:
        cli
        cld
        xorw    %ax, %ax
        movw    %ax, %ds
        movw    %ax, %es
        movw    %ax, %ss
        movw    $0x7c00, %sp
        movb    %dl, boot_drive16
        movw    $0x7e00, cur_offset
        movb    $2, cur_sector

        /* banner over the BIOS console */
        movw    $msg_real, %si
        call    print16

        /* and over COM1, which the test script watches */
        movw    $msg_real, %si
        call    serial16

        /* El Torito (no emulation) already put the continuation at 0x7e00;
         * a hard disk boot only loaded the first sector. */
        cmpl    $MAGIC, 0x7e00
        je      cont

        /* read sectors 2..DISK_SECTORS+1 from head 0, cylinder 0 to 0x7e00.
         * The registers are reloaded from memory every round because int 13h
         * is allowed to change them. */
load_sectors:
        movb    boot_drive16, %dl
        movb    cur_sector, %cl
        movw    cur_offset, %bx
        movb    $0x00, %ch              /* cylinder 0 */
        movb    $0x00, %dh              /* head 0 */
        movb    %dl, last_drive
        movb    %cl, last_sector
        movb    %ch, last_cylinder
        movb    %dh, last_head
        movw    $0x0201, %ax            /* read, 1 sector */
        int     $0x13
        jc      disk_error
        addw    $512, cur_offset
        incb    cur_sector
        cmpb    $(DISK_SECTORS + 2), cur_sector
        jb      load_sectors

        cmpl    $MAGIC, 0x7e00
        jne     magic_error
        cli
        jmp     cont

disk_error:
        movb    %ah, last_error
        movw    $msg_disk_error, %si
        call    print16
        movw    $msg_disk_error, %si
        call    serial16

        /* print the drive number, the cylinder/sector/head the read used and
         * the error code the BIOS returned, as "dd:04:cc:hh:ee" */
        movb    $0x20, %al
        call    serial_byte16
        movb    last_drive, %al
        call    serial_hex8
        movb    $0x3a, %al
        call    serial_byte16
        movb    last_sector, %al
        call    serial_hex8
        movb    $0x3a, %al
        call    serial_byte16
        movb    last_cylinder, %al
        call    serial_hex8
        movb    $0x3a, %al
        call    serial_byte16
        movb    last_head, %al
        call    serial_hex8
        movb    $0x3a, %al
        call    serial_byte16
        movb    last_error, %al
        call    serial_hex8
        call    serial_crlf
        jmp     hang16

magic_error:
        movw    $msg_magic_error, %si
        call    print16
        movw    $msg_magic_error, %si
        call    serial16
        jmp     hang16

/* Print the NUL terminated string in %si with the BIOS teletype call. */
print16:
        pushw   %ax
        pushw   %bx
next_char16:
        lodsb
        testb   %al, %al
        jz      print16_done
        movb    $0x0e, %ah
        movw    $0x0007, %bx
        int     $0x10
        jmp     next_char16
print16_done:
        popw    %bx
        popw    %ax
        ret

/* Print the NUL terminated string in %si to COM1. */
serial16:
        pushw   %ax
next_char16_serial:
        lodsb
        testb   %al, %al
        jz      serial16_done
        call    serial_byte16
        jmp     next_char16_serial
serial16_done:
        popw    %ax
        ret

/* Send %al to COM1. */
serial_byte16:
        pushw   %ax
        pushw   %dx
        movw    $0x03f8, %dx
        outb    %al, %dx
        popw    %dx
        popw    %ax
        ret

serial_crlf:
        pushw   %ax
        movb    $0x0d, %al
        call    serial_byte16
        movb    $0x0a, %al
        call    serial_byte16
        popw    %ax
        ret

/* Print %al as two hex digits to COM1. */
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

serial_nibble:
        andb    $0x0f, %al
        cmpb    $10, %al
        jb      serial_nibble_digit
        addb    $('a' - 10), %al
        jmp     serial_byte16
serial_nibble_digit:
        addb    $'0', %al
        jmp     serial_byte16

hang16:
        cli
        hlt
        jmp     hang16

/*
 * Everything the boot sector needs has to live in the first 512 bytes: on a
 * hard disk boot nothing past 0x7e00 is in memory yet.
 */

/* the drive the BIOS booted from, and where the next sector is read to */
boot_drive16:
        .byte   0
cur_sector:
        .byte   2
cur_offset:
        .word   0x7e00

/* what the last int 13h call used, and what it returned */
last_drive:
        .byte   0
last_sector:
        .byte   0
last_cylinder:
        .byte   0
last_head:
        .byte   0
last_error:
        .byte   0


msg_real:
        .asciz  "v86-64 test: bios boot ok\r\n"
msg_disk_error:
        .asciz  "v86-64 test: disk read failed"
msg_magic_error:
        .asciz  "v86-64 test: continuation magic not found\r\n"

/* --- end of the boot sector ------------------------------------------- */

        .org    510
        .word   0xaa55                  /* MBR / floppy boot signature */

        /* Checked by the loader: this is what an El Torito boot puts at 0x7e00,
         * a hard disk boot has to read it from the disk first. */
        .long   MAGIC

cont:
        movw    $msg_pm, %si
        call    serial16

        /* Enter 32-bit protected mode. */
        cli
        lgdt    gdt_desc
        movl    %cr0, %eax
        orl     $1, %eax                /* CR0.PE */
        movl    %eax, %cr0
        ljmp    $0x18, $mode32

        .code32
mode32:
        movw    $0x10, %ax
        movw    %ax, %ds
        movw    %ax, %es
        movw    %ax, %ss
        movw    %ax, %fs
        movw    %ax, %gs
        movl    $0x9fc00, %esp

        movl    $msg_pm_ok, %esi
        call    serial32

        /* Physical 0x1000: PML4, 0x2000: PDPT, 0x3000: page directory with
         * 512 entries of 2 MiB, so the first gigabyte is identity mapped. */
        movl    $0x1000, %edi
        xorl    %eax, %eax
        movl    $0x1000, %ecx            /* 4 KiB of page tables */
        rep stosl

        movl    $0x2003, 0x1000          /* PML4[0] -> PDPT, present+rw */
        movl    $0x3003, 0x2000          /* PDPT[0] -> page directory */

        movl    $0x3000, %edi
        movl    $0x00000083, %eax
        movl    $512, %ecx
fill_pd:
        movl    %eax, (%edi)
        addl    $0x200000, %eax
        addl    $8, %edi
        loop    fill_pd

        /* Long mode: PAE + LME + CR3 + CR0.PG */
        movl    %cr4, %eax
        orl     $(1 << 5), %eax          /* CR4.PAE */
        movl    %eax, %cr4

        movl    $0xc0000080, %ecx        /* IA32_EFER */
        rdmsr
        orl     $(1 << 8), %eax          /* LME */
        wrmsr

        movl    $0x1000, %eax
        movl    %eax, %cr3

        movl    $msg_lm, %esi
        call    serial32

        cli
        movl    %cr0, %eax
        orl     $0x80000000, %eax        /* CR0.PG */
        movl    %eax, %cr0

        ljmp    $0x08, $mode64           /* 64-bit code segment */

/* Print the NUL terminated string in %esi to COM1 (32-bit code). */
serial32:
        movw    $0x03f8, %dx
serial32_loop:
        movzbl  (%esi), %eax
        testb   %al, %al
        jz      serial32_done
        outb    %al, %dx
        incl    %esi
        jmp     serial32_loop
serial32_done:
        ret

        .code64
mode64:
        movw    $0x10, %ax
        movw    %ax, %ds
        movw    %ax, %es
        movw    %ax, %ss
        movw    %ax, %fs
        movw    %ax, %gs
        movq    $0x90000, %rsp

        leaq    msg_long(%rip), %rsi
        call    serial64

        /* 64-bit arithmetic: REX.W moves, r8-r15, add, shifts, not. */
        movabsq $0x0123456789abcdef, %rax
        movabsq $0x00000000fedcba98, %rbx
        movq    %rax, %r8
        addq    %rbx, %r8                /* r8 = 0x0123456888888887 */
        shlq    $4, %r8                  /* r8 = 0x1234568888888870 */
        notq    %r8                      /* r8 = 0xedcba9777777778f */

        leaq    msg_sum(%rip), %rsi
        call    serial64
        movq    %r8, %rdi
        call    serial_hex64

        /* top nibble of r8 as a hex digit */
        leaq    msg_nibble(%rip), %rsi
        call    serial64
        movq    %r8, %rax
        shrq    $60, %rax
        addq    $'0', %rax
        cmpq    $('9' + 1), %rax
        jb      nibble_done
        addq    $('a' - '0' - 10), %rax
nibble_done:
        call    serial64_byte

        /* and the low 32 bits with a 32-bit operation on the same register */
        leaq    msg_low(%rip), %rsi
        call    serial64
        movq    %r8, %rdi
        movl    %edi, %edi               /* zero extend: 0x7777778f */
        call    serial_hex64

        leaq    msg_eol(%rip), %rsi
        call    serial64

        /* Banner in the VGA text buffer (identity mapped by the 2 MiB page). */
        movabsq $0xb8000, %rdi
        leaq    msg_vga(%rip), %rsi
        movq    $0x1e20, %rax            /* space, blue background */
write_vga:
        movzbl  (%rsi), %ecx
        testb   %cl, %cl
        jz      beep
        movq    %rax, %rdx
        movb    %cl, %dl
        movw    %dx, (%rdi)
        addq    $2, %rdi
        incq    %rsi
        jmp     write_vga

        /* Beep the PC speaker for about a second. */
beep:
        movw    $0x00b6, %ax             /* PIT ch2, mode 3, binary */
        movw    $0x43, %dx
        outb    %al, %dx
        movw    $0x42, %dx
        movb    $0x4c, %al               /* divisor 1356 -> ~880 Hz */
        outb    %al, %dx
        movb    $0x05, %al
        outb    %al, %dx

        inb     $0x61, %al
        orb     $3, %al                  /* speaker data + gate */
        outb    %al, $0x61

        movq    $0x1000000, %rcx            /* about a second of real time */
beep_wait:
        decq    %rcx
        jnz     beep_wait

        inb     $0x61, %al
        andb    $0xfc, %al
        outb    %al, $0x61

        leaq    msg_done(%rip), %rsi
        call    serial64

hang64:
        cli
        hlt
        jmp     hang64

/* Print the NUL terminated string in %rsi to COM1. */
serial64:
        movw    $0x03f8, %dx
serial64_loop:
        movzbl  (%rsi), %eax
        testb   %al, %al
        jz      serial64_done
        outb    %al, %dx
        incq    %rsi
        jmp     serial64_loop
serial64_done:
        ret

serial64_byte:
        pushq   %rdx
        movw    $0x03f8, %dx
        outb    %al, %dx
        popq    %rdx
        ret

/* Print %rdi as 16 hex digits, most significant digit first. */
serial_hex64:
        xorl    %ecx, %ecx
hex_next:
        movq    %rdi, %rax
        shlq    %cl, %rax
        shrq    $60, %rax
        cmpq    $10, %rax
        jb      hex_digit
        addq    $('a' - '0' - 10), %rax
hex_digit:
        addq    $'0', %rax
        pushq   %rcx
        call    serial64_byte
        popq    %rcx
        addq    $4, %rcx
        cmpq    $64, %rcx
        jb      hex_next
        ret

/* ---------------------------------------------------------------------- */

        .align  16
gdt:
        .quad   0x0000000000000000       /* null */
        .quad   0x00af9a000000ffff       /* 0x08: 64-bit code */
        .quad   0x00af92000000ffff       /* 0x10: data */
        .quad   0x00cf9a000000ffff       /* 0x18: 32-bit code */
gdt_end:

gdt_desc:
        .word   gdt_end - gdt - 1
        .long   gdt
        .word   0

msg_pm:
        .asciz  "v86-64 test: entering protected mode\r\n"
msg_pm_ok:
        .asciz  "v86-64 test: protected mode ok\r\n"
msg_lm:
        .asciz  "v86-64 test: entering long mode\r\n"
msg_long:
        .asciz  "v86-64 test: long mode ok\r\n"
msg_sum:
        .asciz  "v86-64 test: sum="
msg_nibble:
        .asciz  " nibble="
msg_low:
        .asciz  " low="
msg_eol:
        .asciz  "\r\n"
msg_done:
        .asciz  "v86-64 test: done\r\n"
msg_vga:
        .asciz  "v86-64 test: 64-bit long mode ok"

        .align  4
        .global image_end
image_end:
