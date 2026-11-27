"""Run a command and reap its spawned OS processes across groups and sessions.

Playwright launches Electron in its own POSIX process group (`detached: true`), and Chromium/Electron on macOS spawns
`chrome_crashpad_handler` via `setsid()` (`PPID = 1`). Every `run_group` call therefore combines live tracking with
environment lineage:
  1. Lock-free `SIGINT`/`SIGTERM` deferral across spawn, registration and `finally` teardown, plus a sticky
     `abort_active()` event so multi-threaded callers (`check.py` compiler pool) stop both running and starting workers.
  2. POSIX: pauses the child on a startup pipe until `kqueue` (`KQ_NOTE_FORK | KQ_NOTE_EXIT`, macOS) or `pidfd` / `/proc`
     polling (Linux) is armed on the leader's `(pid, start_time)`. Keeps the leader as an unreaped zombie until group
     signaling finishes so `os.killpg(leader_pid, SIGKILL)` only ever targets a kernel-anchored group, uses `pidfd_open`
     + `starttime` verification on Linux and `proc_pidinfo` `(tv_sec, tv_usec)` verification on macOS for individual
     PIDs, ignores zombies (`SZOMB` / `Z`), and supplements with `BSTACK_RUN_IDS` across `setsid()` + reparenting.
     macOS XNU limitation: unprivileged `KQ_NOTE_TRACK` is unsupported (`ENOTSUP`) and XNU redacts `KERN_PROCARGS2`
     environment variables on SIP-protected system binaries (`/bin/*`, `/usr/bin/*`), so a short-lived parent that
     detaches a SIP binary via `setsid()` and exits before user-space `kqueue`/`libproc` observes the parent-child link
     cannot be attributed without root (non-SIP binaries such as Node, Electron, Chromium and `chrome_crashpad_handler`
     keep `BSTACK_RUN_IDS` in `ps -E`).
  3. Windows: parent creates a Job Object (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, breakaway disabled) and assigns the
     paused child handle before releasing it to run `cmd`, checks `JobObjectBasicProcessIdList` for `STILL_ACTIVE`
     survivors after `proc.wait()`, and terminates the Job Object in `finally` without clobbering `cmd`'s exit code.
  4. Drains stdout/stderr on daemon threads so inherited pipes cannot block teardown, and fails passing runs (`rc == 0`)
     with `[no-concurrency-escapes]` if any non-zombie descendant survives a 0.75 s exit grace window.
"""
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
import ctypes
import json
import os
import re
import select
import signal
import struct
import subprocess
import sys
import threading
import time
import tomllib
import uuid

ENV_KEY = 'BSTACK_RUN_IDS'
_ENV_PATTERN = re.compile(rf'(?:^|\s){ENV_KEY}=([^\s]+)')
_POSIX_BOOTSTRAP = (
    'import os, sys; fd = int(sys.argv[1]); go = os.read(fd, 1); os.close(fd); '
    'os._exit(130) if go != b"1" else os.execvp(sys.argv[2], sys.argv[2:])'
)
_WIN_BOOTSTRAP = (
    'import json, subprocess, sys; go = sys.stdin.buffer.read(1); '
    'sys.exit(130 if go != b"1" else subprocess.call(json.loads(sys.argv[1]), stdin=subprocess.DEVNULL))'
)

# Mutated only on the main thread; `_on_signal` stays completely lock-free so re-entrant signals cannot self-deadlock.
_DEFER_DEPTH = 0
_PENDING_SIGNAL: int | None = None
_INTERRUPT_LATCHED = False
_HANDLERS_INSTALLED = False

_ACTIVE_LOCK = threading.Lock()
_ACTIVE: set['_Supervisor'] = set()
_ABORTED = threading.Event()


def _on_signal(signum: int, _frame: object) -> None:
    global _PENDING_SIGNAL, _INTERRUPT_LATCHED
    if _DEFER_DEPTH > 0 or _INTERRUPT_LATCHED:
        if _PENDING_SIGNAL is None:
            _PENDING_SIGNAL = signum
        return
    _INTERRUPT_LATCHED = True
    raise KeyboardInterrupt(f'terminated by signal {signum}')


def handle_termination() -> None:
    """Install lock-free, defer-aware SIGINT and SIGTERM handlers on the main thread."""
    global _HANDLERS_INSTALLED
    if threading.current_thread() is not threading.main_thread():
        return
    signal.signal(signal.SIGINT, _on_signal)
    if hasattr(signal, 'SIGTERM'):
        signal.signal(signal.SIGTERM, _on_signal)
    _HANDLERS_INSTALLED = True


@contextmanager
def _scoped_signal_handlers():
    if threading.current_thread() is not threading.main_thread() or _HANDLERS_INSTALLED:
        yield
        return
    prev_int = signal.getsignal(signal.SIGINT)
    prev_term = signal.getsignal(signal.SIGTERM) if hasattr(signal, 'SIGTERM') else None
    signal.signal(signal.SIGINT, _on_signal)
    if hasattr(signal, 'SIGTERM'):
        signal.signal(signal.SIGTERM, _on_signal)
    try:
        yield
    finally:
        signal.signal(signal.SIGINT, prev_int)
        if prev_term is not None:
            signal.signal(signal.SIGTERM, prev_term)


@contextmanager
def defer_signals(*, reraise: bool = True, clear_pending: bool = False):
    global _DEFER_DEPTH, _PENDING_SIGNAL, _INTERRUPT_LATCHED
    on_main = threading.current_thread() is threading.main_thread()
    if on_main:
        _DEFER_DEPTH += 1
    try:
        yield
    finally:
        pending = None
        if on_main:
            _DEFER_DEPTH -= 1
            if _DEFER_DEPTH == 0 and _PENDING_SIGNAL is not None:
                if reraise and not _INTERRUPT_LATCHED:
                    pending = _PENDING_SIGNAL
                    _PENDING_SIGNAL = None
                    _INTERRUPT_LATCHED = True
                elif clear_pending:
                    _PENDING_SIGNAL = None
        if pending is not None:
            raise KeyboardInterrupt(f'terminated by signal {pending}')


def reset_abort() -> None:
    """Clear sticky cancellation and signal latch states before starting a new command or batch."""
    global _PENDING_SIGNAL, _INTERRUPT_LATCHED
    _ABORTED.clear()
    if threading.current_thread() is threading.main_thread():
        _PENDING_SIGNAL = None
        _INTERRUPT_LATCHED = False


def abort_active() -> None:
    """Mark cancellation sticky (blocking starting workers) and terminate all active supervised trees."""
    _ABORTED.set()
    with _ACTIVE_LOCK:
        current = list(_ACTIVE)
    for sup in current:
        sup.terminate()


@dataclass(frozen=True)
class _ProcRow:
    pid: int
    ppid: int
    pgid: int
    start: object
    zombie: bool
    name: str


_LIBC = ctypes.CDLL('/usr/lib/libSystem.B.dylib') if sys.platform == 'darwin' else None
_SZOMB = 5
_PROC_ALL_PIDS = 1
_PROC_PIDTBSDINFO = 3
_BSDINFO_SIZE = 136


def _darwin_one(pid: int, uid: int | None = None) -> _ProcRow | None:
    if _LIBC is None or pid <= 0:
        return None
    buf = ctypes.create_string_buffer(_BSDINFO_SIZE)
    if _LIBC.proc_pidinfo(pid, _PROC_PIDTBSDINFO, 0, buf, _BSDINFO_SIZE) != _BSDINFO_SIZE:
        return None
    raw = buf.raw
    status = struct.unpack_from('<I', raw, 4)[0]
    pbi_pid, pbi_ppid, pbi_uid = struct.unpack_from('<III', raw, 12)
    if uid is not None and pbi_uid != uid:
        return None
    pgid = struct.unpack_from('<I', raw, 100)[0]
    start = struct.unpack_from('<QQ', raw, 120)
    name_bytes = raw[64:96].split(b'\0', 1)[0] or raw[48:64].split(b'\0', 1)[0]
    name = name_bytes.decode('utf-8', 'replace') or str(pbi_pid)
    return _ProcRow(pbi_pid, pbi_ppid, pgid, start, status == _SZOMB, name)


def _darwin_table() -> dict[int, _ProcRow]:
    if _LIBC is None:
        return {}
    uid = os.getuid()
    cap = 4096
    while True:
        pids = (ctypes.c_int * cap)()
        nbytes = _LIBC.proc_listpids(_PROC_ALL_PIDS, 0, pids, ctypes.sizeof(pids))
        if nbytes <= 0:
            return {}
        count = nbytes // ctypes.sizeof(ctypes.c_int)
        if count < cap:
            break
        cap *= 2
    out: dict[int, _ProcRow] = {}
    for i in range(count):
        row = _darwin_one(pids[i], uid)
        if row is not None:
            out[row.pid] = row
    return out


def _darwin_env_pids(token: str) -> set[int]:
    clean_env = {k: v for k, v in os.environ.items() if k != ENV_KEY}
    proc = subprocess.run(['/bin/ps', '-E', '-u', str(os.getuid()), '-ww', '-o', 'pid=,command='],
                          env=clean_env, capture_output=True, text=True)
    if proc.returncode != 0:
        return set()
    matched: set[int] = set()
    for line in proc.stdout.splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) < 2 or not parts[0].isdigit():
            continue
        tokens = {item for match in _ENV_PATTERN.finditer(parts[1]) for item in match.group(1).split(',')}
        if token in tokens:
            matched.add(int(parts[0]))
    return matched


def _linux_one(pid: int, uid: int | None = None) -> _ProcRow | None:
    entry = Path(f'/proc/{pid}')
    try:
        if uid is not None and entry.stat().st_uid != uid:
            return None
        raw = (entry / 'stat').read_text()
        end = raw.rfind(')')
        comm = raw[raw.find('(') + 1:end]
        fields = raw[end + 2:].split()
        state, ppid, pgid, start = fields[0], int(fields[1]), int(fields[2]), fields[19]
    except (OSError, ValueError, IndexError):
        return None
    return _ProcRow(pid, ppid, pgid, start, state == 'Z', comm)


def _linux_table(token: str | None = None) -> tuple[dict[int, _ProcRow], set[int]]:
    proc_root = Path('/proc')
    if not proc_root.is_dir():
        return {}, set()
    uid = os.getuid()
    prefix = f'{ENV_KEY}='.encode()
    out: dict[int, _ProcRow] = {}
    env_pids: set[int] = set()
    for entry in proc_root.iterdir():
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        row = _linux_one(pid, uid)
        if row is None:
            continue
        out[pid] = row
        if token is not None and not row.zombie:
            try:
                environ = (entry / 'environ').read_bytes().split(b'\0')
                tokens = {item.decode('utf-8', 'ignore') for kv in environ if kv.startswith(prefix)
                          for item in kv[len(prefix):].split(b',')}
                if token in tokens:
                    env_pids.add(pid)
            except OSError:
                pass
    return out, env_pids


def _snapshot(token: str | None = None) -> tuple[dict[int, _ProcRow], set[int]]:
    if sys.platform == 'darwin':
        table = _darwin_table()
        env_pids = _darwin_env_pids(token) if token is not None else set()
        return table, env_pids
    if sys.platform.startswith('linux'):
        return _linux_table(token)
    return {}, set()


def _ancestors(self_pid: int, table: dict[int, _ProcRow]) -> tuple[set[int], set[int]]:
    protected = {0, 1, self_pid}
    cur = self_pid
    while (row := table.get(cur)) is not None and row.ppid not in protected:
        protected.add(row.ppid)
        cur = row.ppid
    protected_pgids = {0, 1, os.getpgrp(), *(table[p].pgid for p in protected if p in table)}
    return protected, protected_pgids


_WATCHED_CACHE_KEYS = (
    'TMPDIR',
    'XDG_CACHE_HOME',
    'ELECTRON_CACHE',
    'ELECTRON_BUILDER_CACHE',
    'pnpm_config_store_dir',
    'pnpm_config_cache_dir',
    'pnpm_config_virtual_store_dir',
    'CARGO_HOME',
    'npm_config_cache',
    'COREPACK_HOME',
    'electron_config_cache',
    'PLAYWRIGHT_BROWSERS_PATH',
)


def _in_cwd(cwd: Path, raw: str, home: str | None = None) -> Path:
    if raw == '~' or raw.startswith('~/'):
        base_home = home or str(Path.home())
        expanded = Path(base_home + raw[1:])
    else:
        expanded = Path(raw).expanduser()
    return expanded if expanded.is_absolute() else cwd / expanded


def _probe_effective_env(cwd: Path, base_env: dict, env_file: Path | None) -> tuple[dict[str, str] | None, str | None]:
    base = {str(k): str(v) for k, v in base_env.items()}
    if env_file is None or not env_file.is_file():
        return base, None
    probe_tok = f'probe-{uuid.uuid4().hex}'
    prev_ids = base.get(ENV_KEY, '').strip()
    probe_env = {**base, ENV_KEY: f'{prev_ids},{probe_tok}' if prev_ids else probe_tok}
    probe_py = 'import json, os; print(json.dumps(dict(os.environ)))'
    probe_sh = 'mkdir() { :; }; . "$1" >/dev/null 2>&1 || true; shift; exec "$@"'
    cmd = ['/bin/sh', '-c', probe_sh, 'sh', str(env_file), sys.executable, '-c', probe_py]
    gate_r, gate_w = (-1, -1)
    proc: subprocess.Popen[str] | None = None
    sup: _PosixSupervisor | None = None
    out_chunks: list[str] = []
    out_thread: threading.Thread | None = None
    timed_out = False
    try:
        with defer_signals():
            gate_r, gate_w = os.pipe()
            try:
                proc = subprocess.Popen(
                    [sys.executable, '-c', _POSIX_BOOTSTRAP, str(gate_r), *cmd],
                    cwd=cwd, env=probe_env, stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                    text=True, start_new_session=True, pass_fds=(gate_r,),
                )
            finally:
                os.close(gate_r)
                gate_r = -1
            sup = _PosixSupervisor(proc, probe_tok, {}, set())
            out_thread = _drain(proc.stdout, out_chunks)
            os.write(gate_w, b'1')
            os.close(gate_w)
            gate_w = -1
        deadline = time.monotonic() + 2.0
        while not sup._leader_exited.wait(timeout=0.02):
            row = _darwin_one(sup.leader_pid) if sys.platform == 'darwin' else _linux_one(sup.leader_pid)
            if row is None or row.zombie:
                break
            if time.monotonic() >= deadline:
                timed_out = True
                break
        if not timed_out and out_thread is not None:
            out_thread.join(timeout=0.5)
        raw = ''.join(out_chunks).strip() if not timed_out else ''
        if raw:
            parsed = json.loads(raw.splitlines()[-1])
            if isinstance(parsed, dict):
                res = {str(k): str(v) for k, v in parsed.items() if k != ENV_KEY}
                if ENV_KEY in base:
                    res[ENV_KEY] = base[ENV_KEY]
                return res, None
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    finally:
        with defer_signals(reraise=False):
            if gate_r != -1:
                try:
                    os.close(gate_r)
                except OSError:
                    pass
            if gate_w != -1:
                try:
                    os.close(gate_w)
                except OSError:
                    pass
            if sup is not None:
                sup.stop_watching()
                sup.terminate()
                if proc is not None and proc.returncode is None:
                    try:
                        sup.reap_leader()
                    except OSError:
                        pass
            elif proc is not None and proc.poll() is None:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except OSError:
                    pass
                try:
                    proc.wait()
                except OSError:
                    pass
            if out_thread is not None:
                out_thread.join(timeout=0.2)
    if timed_out:
        return None, f'evaluating $T3_PATCHER_ENV {env_file} timed out'
    return None, f'could not evaluate $T3_PATCHER_ENV {env_file}'


def _pseudo_mounts() -> set[Path]:
    pseudo: set[Path] = set()
    mountinfo = Path('/proc/self/mountinfo')
    if mountinfo.is_file():
        try:
            for line in mountinfo.read_text(encoding='utf-8', errors='replace').splitlines():
                if ' - ' not in line:
                    continue
                left, right = line.split(' - ', 1)
                lf, rf = left.split(), right.split()
                if len(lf) >= 5 and rf:
                    mp = lf[4].replace('\\040', ' ').replace('\\011', '\t').replace('\\134', '\\')
                    if rf[0] in ('autofs', 'devfs', 'devtmpfs', 'proc', 'sysfs'):
                        pseudo.add(Path(mp))
        except OSError:
            pass
    elif sys.platform == 'darwin':
        try:
            proc = subprocess.run(['/sbin/mount'], stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=2)
            for line in proc.stdout.splitlines():
                if ' on ' in line and line.endswith(')'):
                    rest = line.split(' on ', 1)[1]
                    idx = rest.rfind(' (')
                    if idx != -1:
                        mp, opts = rest[:idx], rest[idx + 2:-1]
                        fstype = opts.split(',', 1)[0].strip()
                        if fstype in ('autofs', 'devfs') or 'automounted' in opts:
                            pseudo.add(Path(mp))
        except (OSError, subprocess.SubprocessError):
            pass
    return pseudo


def _is_dangling_symlink(path: Path) -> bool:
    try:
        return path.is_symlink() and not path.exists()
    except OSError:
        return True


def _resolve_cache_probe(cand: Path, pseudo: set[Path]) -> tuple[Path | None, Path | None]:
    for part_path in (cand, *cand.parents):
        if _is_dangling_symlink(part_path):
            return None, None
    try:
        target = cand.resolve()
    except (OSError, RuntimeError):
        return None, None
    if target.exists():
        return (target, None) if target.is_dir() else (None, None)
    for anc in target.parents:
        if not anc.exists():
            continue
        try:
            resolved_anc = anc.resolve()
        except (OSError, RuntimeError):
            return None, None
        if resolved_anc == Path('/') or not resolved_anc.is_dir() or resolved_anc in pseudo:
            return None, None
        try:
            if hasattr(os, 'statvfs') and (os.statvfs(resolved_anc).f_flag & getattr(os, 'ST_RDONLY', 1)):
                return None, None
        except OSError:
            return None, None
        if not os.access(resolved_anc, os.W_OK | os.X_OK):
            return None, None
        return resolved_anc, target
    return None, None


def _watched_mounts(cwd: Path, env: dict) -> tuple[dict[Path, int], set[Path], str | None]:
    """Effective directories whose backing volume holds the checkout or cached binaries, mapped to initial `st_dev`."""
    mounts: dict[Path, int] = {}
    pending_leaves: set[Path] = set()
    home = str(env.get('HOME') or Path.home())
    try:
        resolved_cwd = cwd.resolve()
        if not resolved_cwd.exists():
            return {}, set(), f'required working directory {cwd} is not available'
        mounts[resolved_cwd] = os.stat(resolved_cwd).st_dev
    except (OSError, RuntimeError):
        return {}, set(), f'required working directory {cwd} is not available'

    env_path: Path | None = None
    if raw_patcher_env := str(env.get('T3_PATCHER_ENV', '')).strip():
        env_cand = _in_cwd(resolved_cwd, raw_patcher_env, home)
        for part_path in (env_cand, *env_cand.parents):
            if _is_dangling_symlink(part_path):
                return {}, set(), f'required $T3_PATCHER_ENV directory {env_cand.parent} is not available'
        try:
            env_path = env_cand.resolve()
            probe_dir = env_path.parent
            if not probe_dir.exists():
                return {}, set(), f'required $T3_PATCHER_ENV directory {env_cand.parent} is not available'
            mounts[probe_dir] = os.stat(probe_dir).st_dev
        except (OSError, RuntimeError):
            return {}, set(), f'required $T3_PATCHER_ENV directory {env_cand.parent} is not available'

    eff, probe_err = _probe_effective_env(resolved_cwd, env, env_path)
    if probe_err is not None or eff is None:
        return {}, set(), probe_err
    eff_home = eff.get('HOME') or home
    required: list[tuple[str, Path]] = []
    if raw_cache := eff.get('BSTACK_CACHE_DIR', '').strip():
        required.append(('$BSTACK_CACHE_DIR', _in_cwd(resolved_cwd, raw_cache, eff_home)))
    else:
        config = Path(eff_home) / '.config/b-stack/config.toml'
        if config.is_file():
            try:
                cache_dir = tomllib.loads(config.read_text()).get('cache_dir')
                if isinstance(cache_dir, str) and cache_dir:
                    required.append((f'cache_dir ({config})', _in_cwd(resolved_cwd, cache_dir, eff_home)))
            except (OSError, tomllib.TOMLDecodeError):
                pass
    if raw_watch := eff.get('BSTACK_WATCH_PATH', '').strip():
        required.append(('$BSTACK_WATCH_PATH', _in_cwd(resolved_cwd, raw_watch, eff_home)))
    for label, candidate in required:
        for part_path in (candidate, *candidate.parents):
            if _is_dangling_symlink(part_path):
                return {}, set(), f'required {label} {candidate} is not available'
        try:
            resolved = candidate.resolve()
            if not resolved.exists():
                return {}, set(), f'required {label} {candidate} is not available'
            mounts[resolved] = os.stat(resolved).st_dev
        except (OSError, RuntimeError):
            return {}, set(), f'required {label} {candidate} is not available'

    cache_candidates: list[tuple[str, Path]] = []
    if raw_tools := eff.get('BSTACK_TOOLS_DIR', '').strip():
        cache_candidates.append(('$BSTACK_TOOLS_DIR', _in_cwd(resolved_cwd, raw_tools, eff_home)))
    for key in _WATCHED_CACHE_KEYS:
        if raw_val := eff.get(key, '').strip():
            cache_candidates.append((f'${key}', _in_cwd(resolved_cwd, raw_val, eff_home)))
    if cache_candidates:
        pseudo = _pseudo_mounts()
        for label, cand in cache_candidates:
            try:
                resolved_probe, pending_target = _resolve_cache_probe(cand, pseudo)
                if resolved_probe is None or not resolved_probe.exists():
                    return {}, set(), f'required {label} {cand} is not available'
                mounts[resolved_probe] = os.stat(resolved_probe).st_dev
                if pending_target is not None:
                    pending_leaves.add(pending_target)
            except OSError:
                return {}, set(), f'required {label} {cand} is not available'
    return mounts, pending_leaves, None


def _promote_pending(mounts: dict[Path, int], pending_leaves: set[Path]) -> None:
    for leaf in list(pending_leaves):
        try:
            if leaf.exists():
                resolved_leaf = leaf.resolve()
                mounts[resolved_leaf] = os.stat(resolved_leaf).st_dev
                pending_leaves.discard(leaf)
        except OSError:
            pass


def _lost_mount(mounts: dict[Path, int], pending_leaves: set[Path]) -> str | None:
    """Return which watched path unmounted or remounted on a different `st_dev` (revoking XNU vnodes), else None."""
    _promote_pending(mounts, pending_leaves)
    for path, expected_dev in list(mounts.items()):
        try:
            actual_dev = os.stat(path).st_dev
        except OSError:
            return f'backing path {path} became unavailable (volume unmounted)'
        if actual_dev != expected_dev:
            return f'backing volume for {path} remounted (device {expected_dev} -> {actual_dev})'
    return None


class _Supervisor:
    volume_error: str | None = None

    def wait_leader(self) -> None:
        raise NotImplementedError

    def live_survivors(self, grace_seconds: float = 0.75) -> list[tuple[int, str]]:
        raise NotImplementedError

    def terminate(self) -> None:
        raise NotImplementedError

    def reap_leader(self) -> int:
        raise NotImplementedError


class _WindowsSupervisor(_Supervisor):
    def __init__(self, proc: subprocess.Popen[str]) -> None:
        self.proc = proc
        self._lock = threading.Lock()
        self._job = 0
        if os.name == 'nt':
            import ctypes.wintypes as wt

            k32 = ctypes.WinDLL('kernel32', use_last_error=True)
            self._k32 = k32
            self._wt = wt

            class IO_COUNTERS(ctypes.Structure):
                _fields_ = [(n, ctypes.c_uint64) for n in ('r_ops', 'w_ops', 'o_ops', 'r_bytes', 'w_bytes', 'o_bytes')]

            class BASIC_LIMITS(ctypes.Structure):
                _fields_ = [('PerProcessUserTimeLimit', ctypes.c_int64), ('PerJobUserTimeLimit', ctypes.c_int64),
                            ('LimitFlags', wt.DWORD), ('MinimumWorkingSetSize', ctypes.c_size_t),
                            ('MaximumWorkingSetSize', ctypes.c_size_t), ('ActiveProcessLimit', wt.DWORD),
                            ('Affinity', ctypes.c_size_t), ('PriorityClass', wt.DWORD), ('SchedulingClass', wt.DWORD)]

            class EXTENDED_LIMITS(ctypes.Structure):
                _fields_ = [('BasicLimitInformation', BASIC_LIMITS), ('IoInfo', IO_COUNTERS),
                            ('ProcessMemoryLimit', ctypes.c_size_t), ('JobMemoryLimit', ctypes.c_size_t),
                            ('PeakProcessMemoryUsed', ctypes.c_size_t), ('PeakJobMemoryUsed', ctypes.c_size_t)]

            job = k32.CreateJobObjectW(None, None)
            if not job:
                raise OSError('CreateJobObjectW failed')
            info = EXTENDED_LIMITS()
            info.BasicLimitInformation.LimitFlags = 0x00002000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if not k32.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info)):
                k32.CloseHandle(job)
                raise OSError('SetInformationJobObject failed')
            if not k32.AssignProcessToJobObject(job, int(proc._handle)):  # type: ignore[attr-defined]
                k32.CloseHandle(job)
                raise OSError('AssignProcessToJobObject failed')
            self._job = job

    def wait_leader(self) -> None:
        self.proc.wait()

    def _job_survivors(self) -> list[tuple[int, str]]:
        with self._lock:
            job = self._job
        if not job:
            return []
        wt = self._wt
        k32 = self._k32
        exclude = {os.getpid(), self.proc.pid}
        cap = 256
        while True:
            class PID_LIST(ctypes.Structure):
                _fields_ = [('Assigned', wt.DWORD), ('Count', wt.DWORD), ('Pids', ctypes.c_size_t * cap)]

            buf = PID_LIST()
            if k32.QueryInformationJobObject(job, 3, ctypes.byref(buf), ctypes.sizeof(buf), None):
                out: list[tuple[int, str]] = []
                for i in range(buf.Count):
                    pid = int(buf.Pids[i])
                    if pid in exclude:
                        continue
                    handle = k32.OpenProcess(0x1000, False, pid)
                    if handle:
                        code = wt.DWORD()
                        if k32.GetExitCodeProcess(handle, ctypes.byref(code)) and code.value == 259:
                            out.append((pid, 'process'))
                        k32.CloseHandle(handle)
                return out
            if ctypes.get_last_error() != 234:
                return []
            cap *= 2

    def live_survivors(self, grace_seconds: float = 0.75) -> list[tuple[int, str]]:
        found = self._job_survivors()
        deadline = time.monotonic() + grace_seconds
        while found and time.monotonic() < deadline:
            time.sleep(0.05)
            found = self._job_survivors()
        return found

    def terminate(self) -> None:
        with self._lock:
            if self._job:
                self._k32.TerminateJobObject(self._job, 1)
                self._k32.CloseHandle(self._job)
                self._job = 0
            elif self.proc.poll() is None:
                self.proc.kill()

    def reap_leader(self) -> int:
        return self.proc.wait()


class _PosixSupervisor(_Supervisor):
    def __init__(self, proc: subprocess.Popen[str], token: str, mounts: dict[Path, int],
                 pending_leaves: set[Path]) -> None:
        self.proc = proc
        self.leader_pid = proc.pid
        self.token = token
        self._mounts = mounts
        self._pending_leaves = set(pending_leaves)
        self._last_mount_check = time.monotonic()
        self._lock = threading.Lock()
        self._reap_lock = threading.Lock()
        self._mount_lock = threading.Lock()
        self._stop = threading.Event()
        self._armed = threading.Event()
        self._leader_exited = threading.Event()
        self._leader_reaped = False
        self._tracked: dict[tuple[int, object], str] = {}
        self._kq = select.kqueue() if sys.platform == 'darwin' else None
        self._leader_pidfd = -1
        if hasattr(os, 'pidfd_open'):
            try:
                self._leader_pidfd = os.pidfd_open(self.leader_pid, 0)
            except OSError:
                self._leader_pidfd = -1
        self._watched_pids: set[int] = set()
        self._record_snapshot(include_env=False)
        self._thread = threading.Thread(target=self._watch_loop, daemon=True)
        self._thread.start()
        self._armed.wait(timeout=1.0)

    def _watch_pid(self, pid: int) -> None:
        if self._kq is None or pid in self._watched_pids or pid <= 1:
            return
        self._watched_pids.add(pid)
        try:
            ev = select.kevent(
                pid,
                filter=select.KQ_FILTER_PROC,
                flags=select.KQ_EV_ADD | select.KQ_EV_ENABLE | select.KQ_EV_CLEAR,
                fflags=select.KQ_NOTE_FORK | select.KQ_NOTE_EXIT,
            )
            self._kq.control([ev], 0, 0)
        except OSError:
            if pid == self.leader_pid:
                self._leader_exited.set()

    def _record_snapshot(self, *, include_env: bool) -> dict[int, _ProcRow]:
        table, env_pids = _snapshot(self.token if include_env else None)
        protected, protected_pgids = _ancestors(os.getpid(), table)
        with self._lock:
            leader = table.get(self.leader_pid)
            if leader is not None and not self._tracked:
                self._tracked[(leader.pid, leader.start)] = leader.name
                self._watch_pid(leader.pid)
            if leader is None or leader.zombie:
                self._leader_exited.set()
            live_tracked_pids = {pid for pid, row in table.items()
                                 if pid not in protected and ((pid, row.start) in self._tracked or pid in env_pids)}
            for pid in live_tracked_pids:
                row = table[pid]
                self._tracked[(pid, row.start)] = row.name
                self._watch_pid(pid)
            live_pgids = {table[pid].pgid for pid in live_tracked_pids
                          if table[pid].pgid not in protected_pgids}
            if not self._leader_reaped and self.leader_pid not in protected_pgids:
                live_pgids.add(self.leader_pid)
            changed = True
            while changed:
                changed = False
                for pid, row in table.items():
                    if pid in protected or pid in live_tracked_pids:
                        continue
                    if row.ppid in live_tracked_pids or row.pgid in live_pgids:
                        live_tracked_pids.add(pid)
                        self._tracked[(pid, row.start)] = row.name
                        self._watch_pid(pid)
                        if row.pgid not in protected_pgids:
                            live_pgids.add(row.pgid)
                        changed = True
        return table

    def _watch_loop(self) -> None:
        self._armed.set()
        while not self._stop.is_set():
            if self._kq is not None:
                try:
                    evs = self._kq.control(None, 64, 0.01)
                    for ev in evs:
                        if ev.ident == self.leader_pid and (ev.fflags & select.KQ_NOTE_EXIT):
                            self._leader_exited.set()
                except OSError:
                    time.sleep(0.01)
            elif self._leader_pidfd != -1:
                try:
                    rlist, _, _ = select.select([self._leader_pidfd], [], [], 0.01)
                    if rlist:
                        self._leader_exited.set()
                except OSError:
                    time.sleep(0.01)
            else:
                time.sleep(0.01)
            self._record_snapshot(include_env=False)
            self.promote_mounts()
            now = time.monotonic()
            if now - self._last_mount_check >= 0.25:
                self._last_mount_check = now
                if lost := self.check_mounts():
                    self.volume_error = (
                        f'{lost}; terminated child process tree immediately so revoked-vnode processes cannot spin CPU.'
                    )
                    self.terminate()
                    self._leader_exited.set()
                    return

    def promote_mounts(self) -> None:
        with self._mount_lock:
            if self._pending_leaves:
                _promote_pending(self._mounts, self._pending_leaves)

    def check_mounts(self) -> str | None:
        with self._mount_lock:
            if not self._mounts:
                return None
            return _lost_mount(self._mounts, self._pending_leaves)

    def wait_leader(self) -> None:
        """Wait until the leader process exits into a zombie WITHOUT calling waitpid, keeping its PGID anchored."""
        while not self._leader_exited.wait(timeout=0.05):
            row = _darwin_one(self.leader_pid) if sys.platform == 'darwin' else _linux_one(self.leader_pid)
            if row is None or row.zombie:
                self._leader_exited.set()
                break

    def stop_watching(self) -> None:
        self._stop.set()
        self._thread.join(timeout=1.0)
        if self._kq is not None:
            try:
                self._kq.close()
            except OSError:
                pass
            self._kq = None
        if self._leader_pidfd != -1:
            try:
                os.close(self._leader_pidfd)
            except OSError:
                pass
            self._leader_pidfd = -1

    def live_survivors(self, grace_seconds: float = 0.75) -> list[tuple[int, str]]:
        found = self._current_survivors(include_env=True)
        if not found:
            return []
        deadline = time.monotonic() + grace_seconds
        while found and self.volume_error is None and time.monotonic() < deadline:
            time.sleep(0.05)
            found = self._current_survivors(include_env=True)
        return found if self.volume_error is None else []

    def _current_survivors(self, *, include_env: bool) -> list[tuple[int, str]]:
        table = self._record_snapshot(include_env=include_env)
        protected, _ = _ancestors(os.getpid(), table)
        with self._lock:
            tracked_keys = set(self._tracked)
        return sorted(
            (pid, row.name)
            for pid, row in table.items()
            if pid != self.leader_pid and pid not in protected and not row.zombie and (pid, row.start) in tracked_keys
        )

    def _kill_verified_pid(self, row: _ProcRow) -> None:
        if hasattr(os, 'pidfd_open') and hasattr(signal, 'pidfd_send_signal'):
            fd = -1
            try:
                fd = os.pidfd_open(row.pid, 0)
                cur = _linux_one(row.pid)
                if cur is not None and cur.start == row.start and not cur.zombie:
                    signal.pidfd_send_signal(fd, signal.SIGKILL)
                return
            except OSError:
                pass
            finally:
                if fd != -1:
                    try:
                        os.close(fd)
                    except OSError:
                        pass
        cur = _darwin_one(row.pid) if sys.platform == 'darwin' else _linux_one(row.pid)
        if cur is not None and cur.start == row.start and not cur.zombie:
            try:
                os.kill(row.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError, OSError):
                pass

    def terminate(self) -> None:
        # Serialize anchored leader-group killpg with waitpid (`reap_leader`) so the PGID cannot be recycled mid-call.
        with self._reap_lock:
            if not self._leader_reaped and self.leader_pid > 1 and self.leader_pid != os.getpgrp():
                try:
                    os.killpg(self.leader_pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError, OSError):
                    pass
        for attempt in range(2):
            table = self._record_snapshot(include_env=True)
            protected, _ = _ancestors(os.getpid(), table)
            with self._lock:
                tracked_keys = set(self._tracked)
            targets = [row for pid, row in table.items()
                       if pid not in protected and not row.zombie and (pid, row.start) in tracked_keys]
            if not targets:
                return
            for row in targets:
                self._kill_verified_pid(row)
            if attempt == 0:
                time.sleep(0.03)

    def reap_leader(self) -> int:
        with self._reap_lock:
            rc = self.proc.wait()
            self._leader_reaped = True
            return rc


def _drain(pipe, sink: list[str]) -> threading.Thread:
    def reader() -> None:
        try:
            sink.append(pipe.read())
        finally:
            pipe.close()
    thread = threading.Thread(target=reader, daemon=True)
    thread.start()
    return thread


def run_group(cmd: list[str], cwd: Path, env: dict, *, stream: bool = False,
              check_survivors: bool = True) -> subprocess.CompletedProcess[str]:
    """Run `cmd` inside a supervised process tree, reap every descendant on exit or signal, and fail if a passing
    command leaves non-zombie background or detached processes alive."""
    token = uuid.uuid4().hex
    existing = env.get(ENV_KEY, '')
    child_env = {**env, ENV_KEY: f'{existing},{token}' if existing else token}
    posix = os.name == 'posix'
    out_chunks: list[str] = []
    err_chunks: list[str] = []
    out_thread: threading.Thread | None = None
    err_thread: threading.Thread | None = None
    proc: subprocess.Popen[str] | None = None
    sup: _Supervisor | None = None
    gate_r, gate_w = (-1, -1)
    leak_note = ''
    returncode = 1

    work_cwd = Path(cwd).expanduser()
    work_cwd = work_cwd if work_cwd.is_absolute() else (Path.cwd() / work_cwd)
    with _scoped_signal_handlers():
        mounts, pending_leaves, mount_error = _watched_mounts(work_cwd, child_env) if posix else ({}, set(), None)
        if mount_error is not None:
            note = f'\n[volume-lost] {mount_error}\n'
            if stream:
                sys.stderr.write(note)
            return subprocess.CompletedProcess(cmd, 1, '', note)
        try:
            with defer_signals():
                if _ABORTED.is_set():
                    raise KeyboardInterrupt('aborted')
                if posix:
                    gate_r, gate_w = os.pipe()
                    try:
                        proc = subprocess.Popen(
                            [sys.executable, '-c', _POSIX_BOOTSTRAP, str(gate_r), *cmd],
                            cwd=work_cwd, env=child_env, stdin=subprocess.DEVNULL,
                            stdout=None if stream else subprocess.PIPE,
                            stderr=None if stream else subprocess.PIPE,
                            text=True, start_new_session=True, pass_fds=(gate_r,),
                        )
                    finally:
                        os.close(gate_r)
                        gate_r = -1
                    sup = _PosixSupervisor(proc, token, mounts, pending_leaves)
                else:
                    proc = subprocess.Popen(
                        [sys.executable, '-c', _WIN_BOOTSTRAP, json.dumps(cmd)],
                        cwd=work_cwd, env=child_env, stdin=subprocess.PIPE,
                        stdout=None if stream else subprocess.PIPE,
                        stderr=None if stream else subprocess.PIPE,
                        text=True, creationflags=getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0),
                    )
                    sup = _WindowsSupervisor(proc)
                if not stream:
                    out_thread = _drain(proc.stdout, out_chunks)
                    err_thread = _drain(proc.stderr, err_chunks)
                with _ACTIVE_LOCK:
                    if _ABORTED.is_set() or _PENDING_SIGNAL is not None or _INTERRUPT_LATCHED:
                        raise KeyboardInterrupt('aborted')
                    _ACTIVE.add(sup)
                    if posix and gate_w != -1:
                        os.write(gate_w, b'1')
                        os.close(gate_w)
                        gate_w = -1
                    elif not posix and proc.stdin is not None:
                        proc.stdin.write('1')
                        proc.stdin.flush()
                        proc.stdin.close()

            sup.wait_leader()
            survivors = sup.live_survivors() if (check_survivors and sup.volume_error is None) else []
            if isinstance(sup, _PosixSupervisor):
                sup.stop_watching()
                if sup.volume_error is None:
                    if lost := sup.check_mounts():
                        sup.volume_error = (
                            f'{lost}; terminated child process tree immediately so revoked-vnode processes cannot spin CPU.'
                        )
            if sup.volume_error is not None:
                survivors = []
            sup.terminate()
            returncode = sup.reap_leader()
            if sup.volume_error is not None:
                returncode = 1
                leak_note = f'\n[volume-lost] {sup.volume_error}\n'
            elif returncode == 0 and survivors:
                names = ', '.join(f'{name} (pid {pid})' for pid, name in survivors[:8])
                returncode = 1
                leak_note = (
                    f'\n[no-concurrency-escapes] command left live background process(es) running after exit: '
                    f'{names}. Scope child processes through ChildProcessSpawner '
                    f'(effect/process/ChildProcessSpawner with Effect.scoped, without detaching background '
                    f'children) and close launched apps in journeys; if a tool spawns a background daemon '
                    f'you can\'t scope, stop and report.\n'
                )
        finally:
            with defer_signals(reraise=False):
                if gate_r != -1:
                    try:
                        os.close(gate_r)
                    except OSError:
                        pass
                if gate_w != -1:
                    try:
                        os.close(gate_w)
                    except OSError:
                        pass
                if proc is not None and proc.stdin is not None and not proc.stdin.closed:
                    try:
                        proc.stdin.close()
                    except OSError:
                        pass
                if isinstance(sup, _PosixSupervisor):
                    sup.stop_watching()
                if sup is not None:
                    sup.terminate()
                    with _ACTIVE_LOCK:
                        _ACTIVE.discard(sup)
                    try:
                        returncode = sup.reap_leader() if proc is not None and proc.returncode is None else returncode
                    except OSError:
                        pass
                elif proc is not None and proc.poll() is None:
                    proc.kill()
                    proc.wait()
                if out_thread is not None:
                    out_thread.join(timeout=2.0)
                if err_thread is not None:
                    err_thread.join(timeout=2.0)
            with defer_signals(reraise=True):
                pass

    stdout = ''.join(out_chunks)
    stderr = ''.join(err_chunks) + leak_note
    if stream and leak_note:
        sys.stderr.write(leak_note)
    return subprocess.CompletedProcess(cmd, returncode, stdout, stderr)
