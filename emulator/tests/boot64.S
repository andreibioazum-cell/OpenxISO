/*
 * A tiny bootable program used to test the emulator end to end.
 *
 * It is booted three ways by emulator/tests/make_test_images.py:
 *   - as an El Torito (no emulation) boot image of a small ISO9660 CD image,
 *   - as the boot sector of a raw .hdd image (the rest is read with INT 13h),
 *   - as an ISO again, built with WITH_GRAPHICS=1.
 *
 * Two variants are built from this file:
 *   - WITH_IRQ=1 (default): after the long mode work it remaps the PIC,
 *     programs the PIT to 100 Hz, enables the PS/2 keyboard and mouse and then
 *     waits two seconds. Every interrupt it gets is reported over COM1, so the
 *     test can prove that the emulated timer, keyboard and mouse really reach a
 *     64-bit guest (and that nothing arrives when nothing is typed).
 *   - WITH_GRAPHICS=1: it programs the Bochs VBE interface (ports 0x1CE/0x1CF)
 *     into 640x480x32, fills the linear framebuffer with three colour bands and
 *     reads them back, which the test checks in the guest and on the emulated
 *     screen. The framebuffer is found by reading the PCI BAR of the VGA device
 *     and a page table entry for that gigabyte is built before paging is
 *     enabled.
 *
 * What it always does:
 *   1. real mode: prints a banner with BIOS int 10h and COM1,
 *   2. makes sure the continuation (sector 2 onwards) is in memory,
 *   3. enters 32-bit protected mode and builds 4-level page tables for the
 *      first gigabyte (2 MiB pages) at 0x1000/0x2000/0x3000,
 *   4. switches to 64-bit long mode (PAE + LME + CR0.PG),
 *   5. installs an IDT whose handlers report (and survive) exceptions, so a
 *      fault in 64-bit mode is visible instead of triple faulting the machine,
 *   6. in long mode: prints to COM1, runs 64-bit arithmetic with REX.W ops and
 *      r8-r15, prints the result, writes a banner into the VGA text buffer and
 *      beeps the PC speaker,
 *   7. sets up interrupts or draws to the framebuffer (see above),
 *   8. halts.
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

#ifndef WITH_IRQ
#define WITH_IRQ 1                  /* 1: PIT, keyboard and mouse interrupts */
#endif
#ifndef WITH_GRAPHICS
#define WITH_GRAPHICS 0             /* 1: Bochs VBE 640x480x32 test pattern */
#endif

#define MAGIC       0x0badc0de
#define DISK_SECTORS 16             /* sectors read on a hard disk boot */

#define IDT_BASE      0x10000       /* 256 gates * 16 bytes = 4 KiB, above the loaded image */
#define PD0_BASE      0x3000        /* 2 MiB pages for the first gigabyte */
#define PD_LFB_BASE   0x4000        /* 2 MiB pages for the framebuffer */

#define PIC1_CMD   0x20
#define PIC1_DATA  0x21
#define PIC2_CMD   0xa0
#define PIC2_DATA  0xa1
#define PIT_CMD    0x43
#define PIT_CH0    0x40
#define KBC_DATA   0x60
#define KBC_CMD    0x64
#define VBE_INDEX  0x1ce
#define VBE_DATA   0x1cf

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

/* --- end of the boot sector ------------------------------------------- */

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

        movl    $PD0_BASE, %edi
        movl    $0x00000083, %eax
        movl    $512, %ecx
fill_pd:
        movl    %eax, (%edi)
        addl    $0x200000, %eax
        addl    $8, %edi
        loop    fill_pd

#if WITH_GRAPHICS
        /* Find the framebuffer: PCI bus 0, device 0x12, function 0, BAR0. */
        movl    $0x80009010, %eax        /* enable | bus 0 | dev 0x12 | fn 0 | 0x10 */
        movw    $0x0cf8, %dx
        outl    %eax, %dx
        movw    $0x0cfc, %dx
        inl     %dx, %eax
        movl    %eax, pci_bar0
        andl    $0xfffffff0, %eax

        /* An emulator without a PCI BAR has to answer with all ones (or with
         * nothing at all), and a real OS would then leave the device alone.
         * The framebuffer still works, because the VGA device decodes the
         * address it was built with (0xe0000000 in v86). */
        testl   %eax, %eax
        je      lfb_address_default
        cmpl    $0xfffffff0, %eax
        je      lfb_address_default
        jmp     lfb_address_ok
lfb_address_default:
        movl    $0xe0000000, %eax
lfb_address_ok:
        movl    %eax, lfb_address

        movl    $msg_pci_bar, %esi
        call    serial32
        movl    pci_bar0, %eax
        call    serial_hex32
        movl    $msg_eol, %esi
        call    serial32

        /* Map the gigabyte that contains the framebuffer: the second page
         * directory at 0x4000 gets 2 MiB pages for that region and the PDPT
         * entry for it is filled in. %eax has to be loaded again, because
         * printing the address above used it. */
        movl    lfb_address, %eax
        andl    $0xC0000000, %eax        /* the 1 GiB aligned base */
        movl    %eax, lfb_region
        movl    $PD_LFB_BASE, %edi
        orl     $0x83, %eax
        movl    $512, %ecx
fill_pd_lfb:
        movl    %eax, (%edi)
        addl    $0x200000, %eax
        addl    $8, %edi
        loop    fill_pd_lfb

        movl    lfb_region, %eax
        shrl    $30, %eax                /* PDPT index of the 1 GiB region */
        movl    $PD_LFB_BASE, %edx
        orl     $3, %edx
        movl    %edx, 0x2000(,%eax,8)
#endif

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

/* Send %al to COM1 (32-bit code). */
serial32_byte:
        pushl   %eax
        pushl   %edx
        movw    $0x03f8, %dx
        outb    %al, %dx
        popl    %edx
        popl    %eax
        ret

/* Print %eax as eight hex digits, most significant digit first (32-bit code). */
serial_hex32:
        pushl   %eax
        pushl   %ecx
        movl    $8, %ecx
serial_hex32_loop:
        roll    $4, %eax
        pushl   %eax
        andl    $0x0f, %eax
        addl    $'0', %eax
        cmpl    $('9' + 1), %eax
        jb      serial_hex32_digit
        addl    $('a' - '0' - 10), %eax
serial_hex32_digit:
        call    serial32_byte
        popl    %eax
        decl    %ecx
        jnz     serial_hex32_loop
        popl    %ecx
        popl    %eax
        ret

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

        /* An IDT with handlers for the exception vectors is set up first:
         * without one a fault in the code below would triple fault the
         * machine instead of telling the test what went wrong. */
        call    setup_idt

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

#if !WITH_GRAPHICS
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
#else
        leaq    msg_framebuffer(%rip), %rsi
        call    serial64
        movq    lfb_address(%rip), %rdi
        call    serial_hex64
        leaq    msg_eol(%rip), %rsi
        call    serial64
#endif

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

        movq    $0x1000000, %rcx         /* about a second of real time */
beep_wait:
        decq    %rcx
        jnz     beep_wait

        inb     $0x61, %al
        andb    $0xfc, %al
        outb    %al, $0x61

#if WITH_GRAPHICS
        /* --- Bochs VBE: 640x480x32, three colour bands ------------------- */
        movw    $VBE_INDEX, %dx
        movw    $1, %ax                  /* index 1: width */
        outw    %ax, %dx
        movw    $VBE_DATA, %dx
        movw    $640, %ax
        outw    %ax, %dx

        movw    $VBE_INDEX, %dx
        movw    $2, %ax                  /* index 2: height */
        outw    %ax, %dx
        movw    $VBE_DATA, %dx
        movw    $480, %ax
        outw    %ax, %dx

        movw    $VBE_INDEX, %dx
        movw    $3, %ax                  /* index 3: bits per pixel */
        outw    %ax, %dx
        movw    $VBE_DATA, %dx
        movw    $32, %ax
        outw    %ax, %dx

        movw    $VBE_INDEX, %dx
        movw    $4, %ax                  /* index 4: enable */
        outw    %ax, %dx
        movw    $VBE_DATA, %dx
        movw    $0x41, %ax               /* enabled + linear framebuffer */
        outw    %ax, %dx

        /* 640 * 160 pixels per band, 4 bytes per pixel */
        movq    lfb_address(%rip), %rdi
        movl    $102400, %ecx
        movl    $0x00ff0000, %eax
        call    fill_pixels
        movl    $102400, %ecx
        movl    $0x0000ff00, %eax
        call    fill_pixels
        movl    $102400, %ecx
        movl    $0x000000ff, %eax
        call    fill_pixels

        /* Read one pixel out of every band: this proves that the framebuffer
         * of the emulated card holds what the 64-bit guest wrote to it. */
        leaq    msg_fb(%rip), %rsi
        call    serial64
        movq    lfb_address(%rip), %rdi
        movl    (%rdi), %edi
        call    serial_hex64
        leaq    msg_comma(%rip), %rsi
        call    serial64
        movq    lfb_address(%rip), %rdi
        movl    409600(%rdi), %edi
        call    serial_hex64
        leaq    msg_comma(%rip), %rsi
        call    serial64
        movq    lfb_address(%rip), %rdi
        movl    819200(%rdi), %edi
        call    serial_hex64
        leaq    msg_eol(%rip), %rsi
        call    serial64

        leaq    msg_graphics_ok(%rip), %rsi
        call    serial64
#endif

#if WITH_IRQ
        /* --- interrupts: PIC, PIT and the PS/2 controller ---------------- */
        call    irq_setup_vectors
        call    setup_pic
        call    setup_pit
        call    setup_kbc

        /* the controller answers some of the commands above (the mouse
         * acknowledges "enable data reporting"), and those bytes would look
         * like real input to the test: read them out first */
        call    kbc_drain

        movq    $0, timer_ticks(%rip)
        movq    $0, keyboard_bytes(%rip)
        movq    $0, mouse_bytes(%rip)

        leaq    msg_irq_ready(%rip), %rsi
        call    serial64
        sti

        /* wait for two seconds of PIT ticks (100 Hz) while the test script
         * sends keystrokes and mouse movements */
        movq    $200, %r9
wait_ticks:
        movq    timer_ticks(%rip), %rax
        cmpq    %r9, %rax
        jb      wait_ticks
        cli

        leaq    msg_irq_kbd(%rip), %rsi
        call    serial64
        movq    keyboard_bytes(%rip), %rdi
        call    serial_hex64
        leaq    msg_irq_mouse(%rip), %rsi
        call    serial64
        movq    mouse_bytes(%rip), %rdi
        call    serial_hex64
        leaq    msg_irq_ticks(%rip), %rsi
        call    serial64
        movq    timer_ticks(%rip), %rdi
        call    serial_hex64
        leaq    msg_eol(%rip), %rsi
        call    serial64
#endif

        leaq    msg_done(%rip), %rsi
        call    serial64

hang64:
        cli
        hlt
        jmp     hang64

/* ---------------------------------------------------------------------- */
/* Helpers                                                                */
/* ---------------------------------------------------------------------- */

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

/* Print the byte in %dil as two hex digits (used by the interrupt handlers). */
serial_hex_byte:
        pushq   %rax
        pushq   %rcx
        pushq   %rdx
        pushq   %rdi
        movl    %edi, %eax
        shrl    $4, %eax
        call    serial_hex_digit
        movl    %edi, %eax
        call    serial_hex_digit
        popq    %rdi
        popq    %rdx
        popq    %rcx
        popq    %rax
        ret

serial_hex_digit:
        andl    $0x0f, %eax
        addl    $'0', %eax
        cmpl    $('9' + 1), %eax
        jb      serial_hex_digit_out
        addl    $('a' - '0' - 10), %eax
serial_hex_digit_out:
        jmp     serial64_byte

#if WITH_GRAPHICS
/* Fill %ecx pixels at (%rdi) with the colour in %eax, 4 bytes each. */
fill_pixels:
        movl    %eax, (%rdi)
        addq    $4, %rdi
        decl    %ecx
        jnz     fill_pixels
        ret
#endif

/* ---------------------------------------------------------------------- */
/* Interrupt handling                                                     */
/* ---------------------------------------------------------------------- */

/* Put the 64-bit interrupt gate for %rdi (vector) and %rax (handler)
 * into the IDT at IDT_BASE. */
set_gate64:
        shlq    $4, %rdi
        addq    $IDT_BASE, %rdi
        movw    %ax, 0(%rdi)             /* offset 15:0 */
        shrq    $16, %rax
        movw    %ax, 6(%rdi)             /* offset 31:16 */
        shrq    $16, %rax
        movl    %eax, 8(%rdi)            /* offset 63:32 */
        movw    $0x0008, 2(%rdi)         /* code selector */
        movw    $0x8e00, 4(%rdi)         /* present, DPL 0, 64-bit interrupt gate */
        movl    $0, 12(%rdi)
        ret

/* Build a 256 entry IDT: every vector reports an unexpected exception, the
 * page fault and general protection handlers are patched in afterwards (the
 * interrupt build patches its three IRQ vectors in as well). */
setup_idt:
        movq    $IDT_BASE, %rdi
        movl    $256, %ecx
        leaq    exc_unexpected(%rip), %rbx
idt_fill:
        movq    %rbx, %rax
        movw    %ax, 0(%rdi)
        shrq    $16, %rax
        movw    %ax, 6(%rdi)
        shrq    $16, %rax
        movl    %eax, 8(%rdi)
        movw    $0x0008, 2(%rdi)
        movw    $0x8e00, 4(%rdi)
        movl    $0, 12(%rdi)
        addq    $16, %rdi
        loop    idt_fill

        leaq    exc_general_protection(%rip), %rax
        movl    $13, %edi
        call    set_gate64
        leaq    exc_page_fault(%rip), %rax
        movl    $14, %edi
        call    set_gate64

        leaq    idt_descriptor(%rip), %rax
        lidt    (%rax)
        ret

#if WITH_IRQ
/* Remap the 8259 PICs to vectors 0x20..0x2F and unmask the timer, the keyboard
 * and the mouse (IRQ 0, 1 and 12). */
setup_pic:
        movb    $0x11, %al               /* ICW1: initialize */
        outb    %al, $PIC1_CMD
        outb    %al, $PIC2_CMD
        movb    $0x20, %al               /* ICW2: master offset 0x20 */
        outb    %al, $PIC1_DATA
        movb    $0x28, %al               /* ICW2: slave offset 0x28 */
        outb    %al, $PIC2_DATA
        movb    $0x04, %al               /* ICW3: slave on IRQ2 */
        outb    %al, $PIC1_DATA
        movb    $0x02, %al               /* ICW3: cascade identity */
        outb    %al, $PIC2_DATA
        movb    $0x01, %al               /* ICW4: 8086 mode */
        outb    %al, $PIC1_DATA
        outb    %al, $PIC2_DATA
        movb    $0xf8, %al               /* mask all but IRQ0, IRQ1, IRQ2 */
        outb    %al, $PIC1_DATA
        movb    $0xef, %al               /* slave: only IRQ12 (mouse) */
        outb    %al, $PIC2_DATA
        ret

/* PIT channel 0: 100 Hz rate generator. */
setup_pit:
        movb    $0x34, %al               /* channel 0, lobyte/hibyte, mode 2 */
        outb    %al, $PIT_CMD
        movw    $11932, %ax              /* 1193182 / 100 */
        movw    $PIT_CH0, %dx
        outb    %al, %dx
        movb    %ah, %al
        outb    %al, %dx
        ret

/* 8042: enable the keyboard and the auxiliary (mouse) device and their
 * interrupts, then tell the mouse to report movement. */
setup_kbc:
        call    kbc_wait_write
        movb    $0xa8, %al               /* enable the auxiliary device */
        outb    %al, $KBC_CMD

        call    kbc_wait_write
        movb    $0x20, %al               /* read the configuration byte */
        outb    %al, $KBC_CMD
        call    kbc_wait_read
        inb     $KBC_DATA, %al
        andb    $0xcf, %al               /* clock both devices */
        orb     $0x03, %al               /* enable both interrupts */
        movb    %al, kbc_config(%rip)

        call    kbc_wait_write
        movb    $0x60, %al               /* write the configuration byte */
        outb    %al, $KBC_CMD
        call    kbc_wait_write
        movb    kbc_config(%rip), %al
        outb    %al, $KBC_DATA

        call    kbc_wait_write
        movb    $0xae, %al               /* enable the keyboard */
        outb    %al, $KBC_CMD

        call    kbc_wait_write
        movb    $0xd4, %al               /* next byte goes to the mouse */
        outb    %al, $KBC_CMD
        call    kbc_wait_write
        movb    $0xf4, %al               /* enable data reporting */
        outb    %al, $KBC_DATA
        ret

/* Read and throw away everything the 8042 has already queued (up to 8 bytes). */
kbc_drain:
        pushq   %rax
        pushq   %rcx
        pushq   %rdx
        movl    $8, %ecx
kbc_drain_loop:
        movw    $KBC_CMD, %dx
        inb     %dx, %al
        testb   $1, %al
        jz      kbc_drain_done
        movw    $KBC_DATA, %dx
        inb     %dx, %al
        decl    %ecx
        jnz     kbc_drain_loop
kbc_drain_done:
        popq    %rdx
        popq    %rcx
        popq    %rax
        ret

/* Wait until the 8042 input buffer is empty. */
kbc_wait_write:
        pushq   %rax
        pushq   %rcx
        pushq   %rdx
        xorl    %ecx, %ecx
kbc_wait_write_loop:
        movw    $KBC_CMD, %dx
        inb     %dx, %al
        testb   $2, %al
        jz      kbc_wait_write_done
        incq    %rcx
        cmpq    $1000000, %rcx
        jb      kbc_wait_write_loop
kbc_wait_write_done:
        popq    %rdx
        popq    %rcx
        popq    %rax
        ret

/* Wait until the 8042 output buffer has a byte for us. */
kbc_wait_read:
        pushq   %rax
        pushq   %rcx
        pushq   %rdx
        xorl    %ecx, %ecx
kbc_wait_read_loop:
        movw    $KBC_CMD, %dx
        inb     %dx, %al
        testb   $1, %al
        jnz     kbc_wait_read_done
        incq    %rcx
        cmpq    $1000000, %rcx
        jb      kbc_wait_read_loop
kbc_wait_read_done:
        popq    %rdx
        popq    %rcx
        popq    %rax
        ret

/* End of interrupt: the slave first, then the master. */
irq_eoi:
        pushq   %rax
        movb    $0x20, %al
        outb    %al, $PIC2_CMD
        outb    %al, $PIC1_CMD
        popq    %rax
        ret

/* IRQ0: the 100 Hz timer. */
irq_timer:
        pushq   %rax
        incq    timer_ticks(%rip)
        call    irq_eoi
        popq    %rax
        iretq

/* IRQ1: a keyboard byte is waiting in the 8042. */
irq_keyboard:
        pushq   %rax
        pushq   %rcx
        pushq   %rdx
        pushq   %rsi
        pushq   %rdi
        pushq   %r8

        movw    $KBC_CMD, %dx
        inb     %dx, %al
        testb   $1, %al                  /* anything to read? */
        jz      irq_keyboard_out
        testb   $0x20, %al               /* from the mouse, not the keyboard */
        jnz     irq_keyboard_out

        movw    $KBC_DATA, %dx
        inb     %dx, %al
        movb    %al, irq_byte(%rip)
        incq    keyboard_bytes(%rip)

        leaq    msg_key(%rip), %rsi
        call    serial64
        movzbl  irq_byte(%rip), %edi
        call    serial_hex_byte
        leaq    msg_eol(%rip), %rsi
        call    serial64

irq_keyboard_out:
        call    irq_eoi
        popq    %r8
        popq    %rdi
        popq    %rsi
        popq    %rdx
        popq    %rcx
        popq    %rax
        iretq

/* IRQ12: a byte from the PS/2 mouse. */
irq_mouse:
        pushq   %rax
        pushq   %rcx
        pushq   %rdx
        pushq   %rsi
        pushq   %rdi
        pushq   %r8

        movw    $KBC_CMD, %dx
        inb     %dx, %al
        testb   $1, %al
        jz      irq_mouse_out
        testb   $0x20, %al               /* from the mouse? */
        jz      irq_mouse_out

        movw    $KBC_DATA, %dx
        inb     %dx, %al
        movb    %al, irq_byte(%rip)
        incq    mouse_bytes(%rip)

        leaq    msg_mouse(%rip), %rsi
        call    serial64
        movzbl  irq_byte(%rip), %edi
        call    serial_hex_byte
        leaq    msg_eol(%rip), %rsi
        call    serial64

irq_mouse_out:
        call    irq_eoi
        popq    %r8
        popq    %rdi
        popq    %rsi
        popq    %rdx
        popq    %rcx
        popq    %rax
        iretq

/* Point the three vectors the timer and the two PS/2 devices use at their
 * handlers. */
irq_setup_vectors:
        leaq    irq_timer(%rip), %rax
        movl    $0x20, %edi
        call    set_gate64
        leaq    irq_keyboard(%rip), %rax
        movl    $0x21, %edi
        call    set_gate64
        leaq    irq_mouse(%rip), %rax
        movl    $0x2c, %edi
        call    set_gate64
        ret
#endif

/* ---------------------------------------------------------------------- */
/* Exceptions                                                             */
/* ---------------------------------------------------------------------- */

/* Every exception reports what happened and stops the machine: a real OS
 * would repair the situation or kill the offending task, but for the test it
 * is important that a fault in 64-bit mode is visible instead of turning into
 * a triple fault with no output at all. */
exc_page_fault:
        pushq   %rax
        pushq   %rsi
        pushq   %rdi
        leaq    msg_exception_page_fault(%rip), %rsi
        call    serial64
        movq    %cr2, %rdi
        call    serial_hex64
        leaq    msg_eol(%rip), %rsi
        call    serial64
        jmp     exc_hang

exc_general_protection:
        pushq   %rax
        pushq   %rsi
        leaq    msg_exception_general_protection(%rip), %rsi
        call    serial64
        jmp     exc_hang

exc_unexpected:
        pushq   %rax
        pushq   %rsi
        leaq    msg_exception_unexpected(%rip), %rsi
        call    serial64
exc_hang:
        cli
exc_hang_loop:
        hlt
        jmp     exc_hang_loop

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

idt_descriptor:
        .word   256 * 16 - 1
        .quad   IDT_BASE

#if WITH_IRQ
/* scratch space used by the interrupt handlers */
irq_byte:
        .byte   0
kbc_config:
        .byte   0

        .align  8
timer_ticks:
        .quad   0
keyboard_bytes:
        .quad   0
mouse_bytes:
        .quad   0
#endif

#if WITH_GRAPHICS
        .align  8
lfb_address:
        .quad   0
pci_bar0:
        .long   0
        .long   0
#endif

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
msg_exception_page_fault:
        .asciz  "v86-64 test: page fault at "
msg_exception_general_protection:
        .asciz  "v86-64 test: general protection fault\r\n"
msg_exception_unexpected:
        .asciz  "v86-64 test: unexpected exception\r\n"
#if WITH_IRQ
msg_irq_ready:
        .asciz  "v86-64 test: irq test ready\r\n"
msg_key:
        .asciz  "v86-64 test: key "
msg_mouse:
        .asciz  "v86-64 test: mouse "
msg_irq_kbd:
        .asciz  "v86-64 test: irq keyboard="
msg_irq_mouse:
        .asciz  " mouse="
msg_irq_ticks:
        .asciz  " ticks="
#endif
#if WITH_GRAPHICS
msg_fb:
        .asciz  "v86-64 test: framebuffer read back "
msg_comma:
        .asciz  ","
msg_pci_bar:
        .asciz  "v86-64 test: pci bar0="
msg_framebuffer:
        .asciz  "v86-64 test: framebuffer at "
msg_graphics_ok:
        .asciz  "v86-64 test: graphics ok 640x480x32\r\n"
#endif
#if WITH_GRAPHICS
lfb_region:
        .long   0
        .long   0
#endif

        .align  4
        .global image_end
image_end:
