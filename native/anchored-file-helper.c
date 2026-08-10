#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef O_CLOEXEC
#define O_CLOEXEC 0
#endif
#ifndef O_DIRECTORY
#error "O_DIRECTORY is required"
#endif
#ifndef O_NOFOLLOW
#error "O_NOFOLLOW is required"
#endif

#define MAX_OUTPUT_BYTES ((uint64_t)512 * 1024 * 1024)

static void fail(const char *message) {
  fprintf(stderr, "%s: %s\n", message, strerror(errno));
  exit(1);
}

static void read_exact(int fd, unsigned char *buffer, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t count = read(fd, buffer + offset, length - offset);
    if (count == 0) {
      errno = EPIPE;
      fail("unexpected input EOF");
    }
    if (count < 0) {
      if (errno == EINTR) continue;
      fail("input read failed");
    }
    offset += (size_t)count;
  }
}

static int read_commit_decision(unsigned char *decision) {
  while (1) {
    ssize_t count = read(STDIN_FILENO, decision, 1);
    if (count == 1) return 1;
    if (count == 0) {
      fprintf(stderr, "commit decision input ended before commit\n");
      return 0;
    }
    if (errno == EINTR) continue;
    fprintf(stderr, "commit decision read failed: %s\n", strerror(errno));
    return 0;
  }
}

static int safe_segment(const char *segment) {
  return segment[0] != '\0' && strcmp(segment, ".") != 0 &&
    strcmp(segment, "..") != 0 && strchr(segment, '/') == NULL;
}

static int rollback_file(int directory_fd, int file_fd, const char *name) {
  if (close(file_fd) != 0)
    fprintf(stderr, "anchored output close failed: %s\n", strerror(errno));
  if (unlinkat(directory_fd, name, 0) != 0 && errno != ENOENT) {
    fprintf(stderr, "anchored output rollback failed: %s\n", strerror(errno));
    return 0;
  }
  return 1;
}

int main(int argc, char **argv) {
  if (argc != 6 && argc != 7) {
    fprintf(stderr, "invalid helper arguments\n");
    return 2;
  }
  const char *test_mode = argc == 7 ? argv[6] : "";
  if (test_mode[0] != '\0' && strcmp(test_mode, "exit_after_ready") != 0 &&
      strcmp(test_mode, "hang_after_ready") != 0) {
    fprintf(stderr, "invalid helper protocol mode\n");
    return 2;
  }

  char *relative = strdup(argv[2]);
  if (!relative || relative[0] == '/') {
    fprintf(stderr, "invalid relative path\n");
    return 2;
  }
  char *end = NULL;
  unsigned long long expected_dev = strtoull(argv[3], &end, 10);
  if (!end || *end != '\0') {
    fprintf(stderr, "invalid root device\n");
    return 2;
  }
  unsigned long long expected_ino = strtoull(argv[4], &end, 10);
  if (!end || *end != '\0') {
    fprintf(stderr, "invalid root inode\n");
    return 2;
  }
  unsigned long mode_value = strtoul(argv[5], &end, 8);
  if (!end || *end != '\0' || mode_value > 0777) {
    fprintf(stderr, "invalid file mode\n");
    return 2;
  }

  int directory_fd = open(
    argv[1], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
  );
  if (directory_fd < 0) fail("shadow root open failed");
  struct stat root_stat;
  if (fstat(directory_fd, &root_stat) != 0) fail("shadow root stat failed");
  if (!S_ISDIR(root_stat.st_mode) ||
      (unsigned long long)root_stat.st_dev != expected_dev ||
      (unsigned long long)root_stat.st_ino != expected_ino) {
    fprintf(stderr, "shadow root identity changed\n");
    return 1;
  }

  char *cursor = relative;
  char *slash = NULL;
  while ((slash = strchr(cursor, '/')) != NULL) {
    *slash = '\0';
    if (!safe_segment(cursor)) {
      fprintf(stderr, "invalid parent segment\n");
      return 2;
    }
    if (mkdirat(directory_fd, cursor, 0700) != 0 && errno != EEXIST)
      fail("parent directory creation failed");
    int next_fd = openat(
      directory_fd,
      cursor,
      O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
    );
    if (next_fd < 0) fail("parent directory open failed");
    struct stat parent_stat;
    if (fstat(next_fd, &parent_stat) != 0 || !S_ISDIR(parent_stat.st_mode)) {
      fprintf(stderr, "output parent is not a directory\n");
      return 1;
    }
    close(directory_fd);
    directory_fd = next_fd;
    cursor = slash + 1;
  }
  if (!safe_segment(cursor)) {
    fprintf(stderr, "invalid final segment\n");
    return 2;
  }

  printf("READY\n");
  fflush(stdout);
  if (strcmp(test_mode, "exit_after_ready") == 0) return 73;
  if (strcmp(test_mode, "hang_after_ready") == 0) {
    while (1) pause();
  }

  unsigned char length_bytes[8];
  read_exact(STDIN_FILENO, length_bytes, sizeof(length_bytes));
  uint64_t length = 0;
  for (size_t i = 0; i < sizeof(length_bytes); i++)
    length = (length << 8) | length_bytes[i];
  if (length > MAX_OUTPUT_BYTES) {
    fprintf(stderr, "output exceeds helper limit\n");
    return 2;
  }
  unsigned char *bytes = length == 0 ? NULL : malloc((size_t)length);
  if (length != 0 && !bytes) fail("output allocation failed");
  if (length != 0) read_exact(STDIN_FILENO, bytes, (size_t)length);

  int file_fd = openat(
    directory_fd,
    cursor,
    O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW | O_CLOEXEC,
    (mode_t)mode_value
  );
  if (file_fd < 0) fail("anchored output creation failed");
  size_t offset = 0;
  while (offset < (size_t)length) {
    ssize_t count = write(file_fd, bytes + offset, (size_t)length - offset);
    if (count < 0) {
      if (errno == EINTR) continue;
      unlinkat(directory_fd, cursor, 0);
      fail("anchored output write failed");
    }
    offset += (size_t)count;
  }
  free(bytes);
  if (fsync(file_fd) != 0) {
    unlinkat(directory_fd, cursor, 0);
    fail("anchored output fsync failed");
  }
  struct stat file_stat;
  if (fstat(file_fd, &file_stat) != 0 || !S_ISREG(file_stat.st_mode)) {
    unlinkat(directory_fd, cursor, 0);
    fprintf(stderr, "anchored output is not a regular file\n");
    return 1;
  }
  printf(
    "WRITTEN %llu %llu\n",
    (unsigned long long)file_stat.st_dev,
    (unsigned long long)file_stat.st_ino
  );
  fflush(stdout);

  unsigned char decision = 0;
  int received_decision = read_commit_decision(&decision);
  if (!received_decision || decision != 'C') {
    int rollback_succeeded = rollback_file(directory_fd, file_fd, cursor);
    if (received_decision)
      fprintf(stderr, "anchored output rejected by Host validation\n");
    close(directory_fd);
    free(relative);
    return rollback_succeeded ? 1 : 2;
  }

  if (close(file_fd) != 0) fail("anchored output close failed");
  close(directory_fd);
  free(relative);
  return 0;
}
