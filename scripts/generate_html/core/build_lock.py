"""Serialize normal generator entry points sharing the published summary."""
from __future__ import annotations

from contextlib import contextmanager
import errno
import logging
import os
from pathlib import Path
import time

from core.data_paths import PROJECT_ROOT, project_output_directory

if os.name == "nt":
    import msvcrt
else:
    import fcntl


@contextmanager
def build_lock(project_root: Path = PROJECT_ROOT):
    path = project_output_directory(project_root) / ".build.lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as handle:
        if handle.tell() == 0:
            handle.write(b"\0")
            handle.flush()
        waiting = False
        while True:
            try:
                handle.seek(0)
                if os.name == "nt":
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError as exc:
                if exc.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                    raise
                if not waiting:
                    logging.getLogger(__name__).info("另一次生成正在运行，等待完成")
                    waiting = True
                time.sleep(0.2)
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == "nt":
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
