#!/usr/bin/env python3
import pty, os, sys, select, signal, struct, fcntl, termios, json, errno

def set_winsize(fd, cols, rows):
    winsize = struct.pack('HHHH', rows, cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)

def main():
    cols = int(sys.argv[1]) if len(sys.argv) > 1 else 120
    rows = int(sys.argv[2]) if len(sys.argv) > 2 else 40
    cmd = sys.argv[3] if len(sys.argv) > 3 else 'claude'
    cmd_args = sys.argv[3:] if len(sys.argv) > 3 else ['claude']
    cwd = os.environ.get('PTY_CWD', os.environ.get('HOME', '/'))

    master, slave = pty.openpty()
    set_winsize(master, cols, rows)

    pid = os.fork()
    if pid == 0:
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
        os.dup2(slave, 0)
        os.dup2(slave, 1)
        os.dup2(slave, 2)
        os.close(master)
        os.close(slave)
        os.chdir(cwd)
        os.environ['TERM'] = 'xterm-256color'
        os.execvp(cmd, cmd_args)

    os.close(slave)

    def handle_sigwinch(signum, frame):
        pass

    signal.signal(signal.SIGWINCH, handle_sigwinch)

    stdin_fd = sys.stdin.fileno()
    os.set_blocking(stdin_fd, False)
    os.set_blocking(master, False)

    stdout = sys.stdout.buffer
    try:
        while True:
            try:
                rlist, _, _ = select.select([master, stdin_fd], [], [], 0.1)
            except (select.error, OSError) as e:
                if hasattr(e, 'errno') and e.errno == errno.EINTR:
                    continue
                break

            if master in rlist:
                try:
                    data = os.read(master, 65536)
                    if not data:
                        break
                    stdout.write(data)
                    stdout.flush()
                except OSError:
                    break

            if stdin_fd in rlist:
                try:
                    data = os.read(stdin_fd, 65536)
                    if not data:
                        break
                    if data.startswith(b'\x1b_RESIZE:'):
                        end = data.find(b'\x1b\\')
                        if end != -1:
                            payload = data[len(b'\x1b_RESIZE:'):end]
                            rest = data[end+2:]
                            try:
                                parts = payload.decode().split(',')
                                c, r = int(parts[0]), int(parts[1])
                                set_winsize(master, c, r)
                                os.kill(pid, signal.SIGWINCH)
                            except (ValueError, IndexError):
                                pass
                            if rest:
                                os.write(master, rest)
                            continue
                    os.write(master, data)
                except OSError:
                    break

            pid_result, status = os.waitpid(pid, os.WNOHANG)
            if pid_result != 0:
                try:
                    remaining = os.read(master, 65536)
                    if remaining:
                        stdout.write(remaining)
                        stdout.flush()
                except OSError:
                    pass
                break

    except KeyboardInterrupt:
        pass
    finally:
        try:
            os.close(master)
        except OSError:
            pass
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass

    if os.WIFEXITED(status):
        sys.exit(os.WEXITSTATUS(status))
    sys.exit(1)

if __name__ == '__main__':
    main()
