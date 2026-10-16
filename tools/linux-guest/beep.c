/*
 * beep - ring the emulated PC speaker from a real 64-bit Linux guest.
 *
 * The kernel's PC Speaker driver (CONFIG_INPUT_PCSPKR) exposes the speaker as
 * an input device: writing an EV_SND/SND_TONE event to its evdev node makes the
 * driver program the 8253 timer and the 8255 port, which is exactly the
 * hardware the emulator listens to.  So this program, the kernel's input layer
 * and the emulator's AudioContext make one chain - the guest really does make
 * the machine's speaker sound.
 *
 *     beep            # 880 Hz for 200 ms
 *     beep 440 500    # 440 Hz for 500 ms
 *
 * It is built statically (the initramfs has no shared libraries), so the
 * kernel/uapi headers are not used: the small structures are defined here.
 */

#include <dirent.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/time.h>
#include <unistd.h>

#define EV_SND 0x12
#define SND_BELL 0x01
#define SND_TONE 0x02

/* the driver's name ("PC Speaker"), which is what we are looking for */
#define SPEAKER_NAME "Speaker"

struct input_event {
    struct timeval time;
    unsigned short type;
    unsigned short code;
    int value;
};

/* _IOC(_IOC_READ, 'E', 0x06, len): "what is this device called?" */
#define EVIOCGNAME(len) _IOC(_IOC_READ, 'E', 0x06, len)

/** Open the evdev node of the PC speaker; -1 if there is none. */
static int open_speaker(char *path, size_t path_size)
{
    for (int index = 0; index < 32; index++) {
        char candidate[64];
        char name[128];
        snprintf(candidate, sizeof(candidate), "/dev/input/event%d", index);
        int fd = open(candidate, O_WRONLY);
        if (fd < 0) {
            continue;
        }
        memset(name, 0, sizeof(name));
        if (ioctl(fd, EVIOCGNAME(sizeof(name) - 1), name) >= 0 &&
                strstr(name, SPEAKER_NAME) != NULL) {
            snprintf(path, path_size, "%s", candidate);
            return fd;
        }
        close(fd);
    }
    return -1;
}

static int tone(int fd, int frequency)
{
    struct input_event event;
    memset(&event, 0, sizeof(event));
    event.type = EV_SND;
    event.code = SND_TONE;
    event.value = frequency;
    return write(fd, &event, sizeof(event)) == sizeof(event) ? 0 : -1;
}

int main(int argc, char **argv)
{
    int frequency = 880;
    int milliseconds = 200;

    if (argc > 1) {
        frequency = atoi(argv[1]);
    }
    if (argc > 2) {
        milliseconds = atoi(argv[2]);
    }
    if (frequency < 20 || frequency > 20000 || milliseconds < 1 || milliseconds > 10000) {
        fprintf(stderr, "usage: beep [frequency 20..20000] [milliseconds 1..10000]\n");
        return 2;
    }

    char path[64];
    int fd = open_speaker(path, sizeof(path));
    if (fd < 0) {
        fprintf(stderr, "beep: no PC speaker device in /dev/input "
                        "(is CONFIG_INPUT_PCSPKR built in?)\n");
        return 1;
    }

    if (tone(fd, frequency) != 0) {
        fprintf(stderr, "beep: %s did not take the tone\n", path);
        close(fd);
        return 1;
    }
    printf("beep: %d Hz for %d ms through %s\n", frequency, milliseconds, path);
    fflush(stdout);

    struct timespec pause = { milliseconds / 1000, (milliseconds % 1000) * 1000000L };
    nanosleep(&pause, NULL);

    tone(fd, 0);
    close(fd);
    return 0;
}
