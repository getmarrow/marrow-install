#!/usr/bin/env python3
# Runs a command under a pseudo-terminal for the update tests and answers the confirmation word prompt.
# Usage: pty-run.py MODE -- command args...
# MODE: word (types the printed word), wrong (the word in upper case), space (the word and a trailing space),
# empty (an empty line), eof (end of input), early (a guess typed before the prompt), stdout-pipe (stdin a TTY,
# stdout a pipe, the word typed), stdin-pipe (stdout a TTY, stdin a pipe that carries the word).
# Prints the transcript and exits with the command's exit code.
import os
import re
import select
import subprocess
import sys
import time

mode = sys.argv[1]
command = sys.argv[3:]
master, slave = os.openpty()
stdin = subprocess.PIPE if mode == 'stdin-pipe' else slave
stdout = subprocess.PIPE if mode == 'stdout-pipe' else slave
proc = subprocess.Popen(command, stdin=stdin, stdout=stdout, stderr=subprocess.STDOUT if stdout != slave else slave,
                        start_new_session=True, close_fds=True)
os.close(slave)


def send(text):
    if mode == 'stdin-pipe':
        try:
            proc.stdin.write(text.encode())
            proc.stdin.flush()
        except OSError:
            pass
    else:
        os.write(master, text.encode())


if mode == 'early':
    send('remove-000000\n')
transcript = b''
answered = False
deadline = time.time() + 60
sources = [master] + ([proc.stdout.fileno()] if mode == 'stdout-pipe' else [])
while sources and time.time() < deadline:
    ready, _, _ = select.select(sources, [], [], 0.2)
    for fd in ready:
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            chunk = b''
        if not chunk:
            sources.remove(fd)
            continue
        transcript += chunk
    found = re.search(rb'confirmation word (\S+) and', transcript)
    if found and not answered:
        answered = True
        word = found.group(1).decode()
        answer = {'wrong': word.upper() + '\n', 'space': word + ' \n', 'empty': '\n', 'eof': '\x04', 'early': '\n'}.get(mode, word + '\n')
        send(answer)
    if proc.poll() is not None and not ready:
        break
try:
    proc.wait(timeout=max(1, deadline - time.time()))
except subprocess.TimeoutExpired:
    proc.kill()
    proc.wait()
sys.stdout.write(transcript.decode('utf-8', 'replace'))
sys.exit(proc.returncode if proc.returncode is not None else 1)
