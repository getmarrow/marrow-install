/*
 * marrow-hook: native hook shim for marrow-agentd (Linux and macOS).
 *
 * The harness runs this for every hook event:  marrow-hook <harness> <event>
 * It reads the hook's stdin, sends it to the daemon over the Unix socket, and relays the
 * daemon's rendered stdout, stderr and exit code. It never interprets the payload, reads no
 * environment variable and runs no shell. If the daemon cannot be reached, it execs the Node
 * fallback (classifies locally; routine passes with a recorded bypass, risky fails closed).
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

static int valid_token(const char *s) {
  size_t n = strlen(s);
  if (n == 0 || n > 32 || s[0] == '-') return 0;
  for (size_t i = 0; i < n; i++) {
    char c = s[i];
    if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '-')) return 0;
  }
  return 1;
}

static long deadline_ms_for(const char *harness) {
  /* Must stay below the host hook timeout the installer writes (codex 5 s, claude-code 15 s). */
  if (strcmp(harness, "codex") == 0) return 4000;
  if (strcmp(harness, "claude-code") == 0) return 14000;
  return 4000;
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

static void set_timeouts(int fd, long ms) {
  struct timeval tv;
  if (ms < 1) ms = 1;
  tv.tv_sec = ms / 1000;
  tv.tv_usec = (ms % 1000) * 1000;
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
  setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
}

/* Returns 0 and fills the response on success; -1 when the daemon cannot be used. */
static int call_daemon(const char *harness, const char *event, const unsigned char *input, size_t input_len,
                       unsigned char **resp, size_t *resp_len) {
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
  set_timeouts(fd, deadline_ms_for(harness));
  int rc = connect(fd, (struct sockaddr *)&addr, sizeof addr);
  if (cwd >= 0) { if (fchdir(cwd) != 0) { /* keep going; fallback uses absolute paths */ } close(cwd); }
  if (rc != 0) { close(fd); return -1; }

  char header[128];
  int hn = snprintf(header, sizeof header, "MRWH1 %s %s %ld\n", harness, event, (long)getpid());
  if (hn <= 0 || (size_t)hn >= sizeof header) { close(fd); return -1; }
  if (write_all(fd, (const unsigned char *)header, (size_t)hn) != 0 || write_all(fd, input, input_len) != 0) { close(fd); return -1; }
  shutdown(fd, SHUT_WR);

  unsigned char *buf = NULL;
  size_t len = 0;
  if (read_all(fd, &buf, &len, MAX_RESPONSE) != 0) { close(fd); return -1; }
  close(fd);
  *resp = buf;
  *resp_len = len;
  return 0;
}

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
  if ((unsigned long long)out_len + err_len != body) return -1;
  const unsigned char *p = nl + 1;
  if (write_all(STDOUT_FILENO, p, out_len) != 0) return -1;
  if (write_all(STDERR_FILENO, p + out_len, err_len) != 0) return -1;
  return code;
}

static int run_fallback(const char *harness, const char *event, const unsigned char *input, size_t input_len) {
  int fds[2];
  if (pipe(fds) != 0) return -1;
  pid_t pid = fork();
  if (pid < 0) { close(fds[0]); close(fds[1]); return -1; }
  if (pid == 0) {
    dup2(fds[0], STDIN_FILENO);
    close(fds[0]);
    close(fds[1]);
    char *const argv[] = { (char *)MARROW_NODE, (char *)MARROW_FALLBACK, (char *)"--home", (char *)MARROW_HOME,
                           (char *)"--fallback", (char *)harness, (char *)event, NULL };
    /* A fixed environment: nothing from the governed agent (NODE_OPTIONS, MARROW_*, HOME)
     * reaches the fallback process. */
    char *const envp[] = { (char *)"PATH=/usr/bin:/bin", (char *)"LANG=C", NULL };
    execve(MARROW_NODE, argv, envp);
    _exit(127);
  }
  close(fds[0]);
  write_all(fds[1], input, input_len);
  close(fds[1]);
  int status = 0;
  while (waitpid(pid, &status, 0) < 0) { if (errno != EINTR) return -1; }
  if (!WIFEXITED(status) || WEXITSTATUS(status) == 127) return -1;
  return WEXITSTATUS(status);
}

int main(int argc, char **argv) {
  signal(SIGPIPE, SIG_IGN);
  if (argc != 3 || !valid_token(argv[1]) || !valid_token(argv[2])) {
    static const char usage[] = "marrow-hook: usage: marrow-hook <harness> <event>\n";
    write_all(STDERR_FILENO, (const unsigned char *)usage, sizeof usage - 1);
    return 2;
  }
  const char *harness = argv[1];
  const char *event = argv[2];
  int is_pre = strcmp(event, "pre") == 0;

  unsigned char *input = NULL;
  size_t input_len = 0;
  if (read_all(STDIN_FILENO, &input, &input_len, MAX_INPUT + 1) != 0) { input = NULL; input_len = 0; }

  unsigned char *resp = NULL;
  size_t resp_len = 0;
  if (call_daemon(harness, event, input ? input : (const unsigned char *)"", input_len, &resp, &resp_len) == 0) {
    int code = relay_response(resp, resp_len);
    free(resp);
    if (code >= 0) { free(input); return code; }
  }
  int code = run_fallback(harness, event, input ? input : (const unsigned char *)"", input_len);
  free(input);
  if (code >= 0) return code;
  if (is_pre) {
    static const char msg[] = "Marrow: local service and fallback unavailable; blocked for safety.\n";
    write_all(STDERR_FILENO, (const unsigned char *)msg, sizeof msg - 1);
    return 2;
  }
  return 0;
}
