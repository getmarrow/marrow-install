/*
 * marrow-hook: native hook shim for marrow-agentd (Linux and macOS).
 *
 * The harness runs this for every hook event:  marrow-hook <harness> <event>
 * It reads the hook's stdin, sends it to the daemon over the Unix socket, and relays the
 * daemon's rendered stdout, stderr and exit code. It never interprets the payload, reads no
 * environment variable and runs no shell. If the daemon cannot be reached in time, it runs the
 * Node fallback (classifies locally; routine passes with a recorded bypass, risky fails closed).
 *
 * Safety rules for a pre-action event ("pre"): the shim only ever ends with
 *   - the daemon's rendered answer, or
 *   - the fallback's answer when it exited 2, or exited 0 with a non-empty stdout, or
 *   - exit 2 with a blocking message.
 * A crashed, hung or silent fallback therefore blocks instead of letting the tool run.
 *
 * All paths are fixed at build time by the installer, and the installer pins the binary's
 * sha256 in the daemon config:
 *   -DMARROW_SOCKET_DIR="<home>/.marrow/agentd/run"
 *   -DMARROW_NODE="<absolute node binary>"
 *   -DMARROW_FALLBACK="<absolute path to hook-entry.js>"
 *   -DMARROW_HOME="<home>"
 * Wire protocol: see protocol.js (MRWH1 request header, MRWR1 response header).
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#if !defined(MARROW_SOCKET_DIR) || !defined(MARROW_NODE) || !defined(MARROW_FALLBACK) || !defined(MARROW_HOME)
#error "build with -DMARROW_SOCKET_DIR, -DMARROW_NODE, -DMARROW_FALLBACK and -DMARROW_HOME"
#endif

#define MAX_INPUT (16u * 1024u * 1024u)
#define MAX_RESPONSE (32u * 1024u * 1024u)
#define MAX_FALLBACK_OUTPUT (1u * 1024u * 1024u)

static int valid_token(const char *s) {
  size_t n = strlen(s);
  if (n == 0 || n > 32 || s[0] == '-') return 0;
  for (size_t i = 0; i < n; i++) {
    char c = s[i];
    if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '-')) return 0;
  }
  return 1;
}

/* Budgets stay below the host hook timeout the installer writes (codex 5 s, claude-code 15 s):
 * daemon phase + fallback phase < host timeout. */
static long daemon_budget_ms(const char *harness) {
  if (strcmp(harness, "claude-code") == 0) return 11000;
  return 3000;
}
static long fallback_budget_ms(const char *harness) {
  if (strcmp(harness, "claude-code") == 0) return 3000;
  return 1500;
}

static long long now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static int read_all(int fd, unsigned char **out, size_t *len, size_t cap) {
  size_t size = 65536, used = 0;
  unsigned char *buf = malloc(size);
  if (!buf) return -1;
  for (;;) {
    if (used == size) {
      if (size >= cap) break; /* stop at cap; the daemon reports oversize input */
      size_t next = size * 2 > cap ? cap : size * 2;
      unsigned char *grown = realloc(buf, next);
      if (!grown) { free(buf); return -1; }
      buf = grown;
      size = next;
    }
    ssize_t r = read(fd, buf + used, size - used);
    if (r < 0) { if (errno == EINTR) continue; free(buf); return -1; }
    if (r == 0) break;
    used += (size_t)r;
  }
  *out = buf;
  *len = used;
  return 0;
}

static int write_all(int fd, const unsigned char *buf, size_t len) {
  while (len > 0) {
    ssize_t w = write(fd, buf, len);
    if (w < 0) { if (errno == EINTR) continue; return -1; }
    buf += w;
    len -= (size_t)w;
  }
  return 0;
}

/* Waits until fd is ready or the absolute deadline passes. Returns 1 ready, 0 timeout, -1 error. */
static int wait_fd(int fd, short events, long long deadline) {
  for (;;) {
    long long left = deadline - now_ms();
    if (left <= 0) return 0;
    struct pollfd p = { .fd = fd, .events = events, .revents = 0 };
    int rc = poll(&p, 1, (int)(left > 60000 ? 60000 : left));
    if (rc < 0) { if (errno == EINTR) continue; return -1; }
    if (rc == 0) continue;
    return 1;
  }
}

static int write_deadline(int fd, const unsigned char *buf, size_t len, long long deadline) {
  while (len > 0) {
    if (wait_fd(fd, POLLOUT, deadline) != 1) return -1;
    ssize_t w = write(fd, buf, len);
    if (w < 0) { if (errno == EINTR || errno == EAGAIN) continue; return -1; }
    buf += w;
    len -= (size_t)w;
  }
  return 0;
}

static int read_deadline(int fd, unsigned char **out, size_t *len, size_t cap, long long deadline) {
  size_t size = 4096, used = 0;
  unsigned char *buf = malloc(size);
  if (!buf) return -1;
  for (;;) {
    if (used == size) {
      if (size >= cap) { free(buf); return -1; }
      size_t next = size * 2 > cap ? cap : size * 2;
      unsigned char *grown = realloc(buf, next);
      if (!grown) { free(buf); return -1; }
      buf = grown;
      size = next;
    }
    if (wait_fd(fd, POLLIN, deadline) != 1) { free(buf); return -1; }
    ssize_t r = read(fd, buf + used, size - used);
    if (r < 0) { if (errno == EINTR || errno == EAGAIN) continue; free(buf); return -1; }
    if (r == 0) break;
    used += (size_t)r;
  }
  *out = buf;
  *len = used;
  return 0;
}

/* Returns 0 and fills the response on success; -1 when the daemon cannot be used in time. */
static int call_daemon(const char *harness, const char *event, const unsigned char *input, size_t input_len,
                       unsigned char **resp, size_t *resp_len, long long deadline) {
  struct sockaddr_un addr;
  int cwd = open(".", O_RDONLY | O_CLOEXEC);
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) { if (cwd >= 0) close(cwd); return -1; }
  fcntl(fd, F_SETFD, FD_CLOEXEC);
  memset(&addr, 0, sizeof addr);
  addr.sun_family = AF_UNIX;
  /* chdir + relative name keeps long home paths under the sun_path limit. */
  if (chdir(MARROW_SOCKET_DIR) != 0) { close(fd); if (cwd >= 0) close(cwd); return -1; }
  strncpy(addr.sun_path, "agentd.sock", sizeof addr.sun_path - 1);
  int rc = connect(fd, (struct sockaddr *)&addr, sizeof addr);
  if (cwd >= 0) { if (fchdir(cwd) != 0) { /* fallback uses absolute paths */ } close(cwd); }
  if (rc != 0) { close(fd); return -1; }
  fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);

  char header[128];
  int hn = snprintf(header, sizeof header, "MRWH1 %s %s %ld\n", harness, event, (long)getpid());
  if (hn <= 0 || (size_t)hn >= sizeof header) { close(fd); return -1; }
  if (write_deadline(fd, (const unsigned char *)header, (size_t)hn, deadline) != 0
      || write_deadline(fd, input, input_len, deadline) != 0) { close(fd); return -1; }
  shutdown(fd, SHUT_WR);

  unsigned char *buf = NULL;
  size_t len = 0;
  if (read_deadline(fd, &buf, &len, MAX_RESPONSE, deadline) != 0) { close(fd); return -1; }
  close(fd);
  *resp = buf;
  *resp_len = len;
  return 0;
}

/* Validates the daemon response completely before writing anything. */
static int relay_response(const unsigned char *resp, size_t len) {
  const unsigned char *nl = memchr(resp, '\n', len > 64 ? 64 : len);
  if (!nl) return -1;
  char header[65];
  size_t hlen = (size_t)(nl - resp);
  memcpy(header, resp, hlen);
  header[hlen] = '\0';
  int code = -1;
  unsigned long out_len = 0, err_len = 0;
  char magic[8];
  if (sscanf(header, "%7s %d %lu %lu", magic, &code, &out_len, &err_len) != 4) return -1;
  if (strcmp(magic, "MRWR1") != 0 || code < 0 || code > 255) return -1;
  size_t body = len - hlen - 1;
  /* No addition, so no wrap-around: out_len must fit, and err_len must be exactly the rest. */
  if (out_len > body || err_len != body - out_len) return -1;
  const unsigned char *p = nl + 1;
  if (write_all(STDOUT_FILENO, p, out_len) != 0) return -1;
  if (write_all(STDERR_FILENO, p + out_len, err_len) != 0) return -1;
  return code;
}

/* Runs the fallback with a deadline. Its stdout is captured so a pre-action result can be
 * checked before anything reaches the harness. Returns the exit code, or -1 on crash/timeout. */
static int run_fallback(const char *harness, const char *event, const unsigned char *input, size_t input_len,
                        unsigned char **out, size_t *out_len, long long deadline) {
  int in_pipe[2], out_pipe[2];
  if (pipe(in_pipe) != 0) return -1;
  if (pipe(out_pipe) != 0) { close(in_pipe[0]); close(in_pipe[1]); return -1; }
  pid_t pid = fork();
  if (pid < 0) { close(in_pipe[0]); close(in_pipe[1]); close(out_pipe[0]); close(out_pipe[1]); return -1; }
  if (pid == 0) {
    dup2(in_pipe[0], STDIN_FILENO);
    dup2(out_pipe[1], STDOUT_FILENO);
    close(in_pipe[0]); close(in_pipe[1]); close(out_pipe[0]); close(out_pipe[1]);
    char *const argv[] = { (char *)MARROW_NODE, (char *)MARROW_FALLBACK, (char *)"--home", (char *)MARROW_HOME,
                           (char *)"--fallback", (char *)harness, (char *)event, NULL };
    /* A fixed environment: nothing from the governed agent (NODE_OPTIONS, MARROW_*, HOME)
     * reaches the fallback process. */
    char *const envp[] = { (char *)"PATH=/usr/bin:/bin", (char *)"LANG=C", NULL };
    execve(MARROW_NODE, argv, envp);
    _exit(127);
  }
  close(in_pipe[0]);
  close(out_pipe[1]);
  /* Stdin is at most 16 MiB and the fallback reads it all before writing, so feed it first. */
  fcntl(in_pipe[1], F_SETFL, fcntl(in_pipe[1], F_GETFL) | O_NONBLOCK);
  int wrote = write_deadline(in_pipe[1], input, input_len, deadline);
  close(in_pipe[1]);
  unsigned char *buf = NULL;
  size_t len = 0;
  int read_ok = wrote == 0 ? read_deadline(out_pipe[0], &buf, &len, MAX_FALLBACK_OUTPUT, deadline) : -1;
  close(out_pipe[0]);
  int status = 0;
  if (read_ok != 0) {
    kill(pid, SIGKILL);
    while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {}
    free(buf);
    return -1;
  }
  for (;;) {
    pid_t done = waitpid(pid, &status, WNOHANG);
    if (done == pid) break;
    if (done < 0 && errno != EINTR) { free(buf); return -1; }
    if (now_ms() >= deadline) {
      kill(pid, SIGKILL);
      while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {}
      free(buf);
      return -1;
    }
    struct timespec pause = { 0, 5 * 1000 * 1000 };
    nanosleep(&pause, NULL);
  }
  if (!WIFEXITED(status) || WEXITSTATUS(status) == 127) { free(buf); return -1; }
  *out = buf;
  *out_len = len;
  return WEXITSTATUS(status);
}

static int block(const char *message) {
  write_all(STDERR_FILENO, (const unsigned char *)message, strlen(message));
  return 2;
}

int main(int argc, char **argv) {
  signal(SIGPIPE, SIG_IGN);
  long long started = now_ms();
  if (argc != 3 || !valid_token(argv[1]) || !valid_token(argv[2])) {
    return block("marrow-hook: usage: marrow-hook <harness> <event>\n");
  }
  const char *harness = argv[1];
  const char *event = argv[2];
  int is_pre = strcmp(event, "pre") == 0;

  unsigned char *input = NULL;
  size_t input_len = 0;
  if (read_all(STDIN_FILENO, &input, &input_len, MAX_INPUT + 1) != 0) { input = NULL; input_len = 0; }
  const unsigned char *payload = input ? input : (const unsigned char *)"";

  unsigned char *resp = NULL;
  size_t resp_len = 0;
  if (call_daemon(harness, event, payload, input_len, &resp, &resp_len, started + daemon_budget_ms(harness)) == 0) {
    int code = relay_response(resp, resp_len);
    free(resp);
    if (code >= 0) { free(input); return code; }
  }

  unsigned char *out = NULL;
  size_t out_len = 0;
  int code = run_fallback(harness, event, payload, input_len, &out, &out_len, now_ms() + fallback_budget_ms(harness));
  free(input);
  if (!is_pre) {
    if (code >= 0 && out_len > 0) write_all(STDOUT_FILENO, out, out_len);
    free(out);
    return 0; /* telemetry events never disturb the agent */
  }
  if ((code == 0 && out_len > 0) || code == 2) {
    if (out_len > 0) write_all(STDOUT_FILENO, out, out_len);
    free(out);
    return code;
  }
  free(out);
  return block("Marrow: the local service and its fallback did not answer; this action is blocked for safety. Owner: run marrow-agentd doctor.\n");
}
