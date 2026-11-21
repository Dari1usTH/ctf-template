"""Extract untrusted TAR/ZIP files into an empty staging directory, never the workspace."""
import os
import re
import stat
import sys
import tarfile
import zipfile
from pathlib import Path

MAX_FILES = 10000
MAX_BYTES = 1024 * 1024 * 1024


def clean_name(name):
    if not name or name.startswith('/') or '\\' in name or re.search(r'[\x00-\x1f\x7f]', name):
        raise ValueError('Invalid archive path.')
    while name.startswith('./'):
        name = name[2:]
    name = name.rstrip('/')
    if name in ('', '.'):
        return None
    if name.startswith('/') or re.match(r'^[A-Za-z]:', name) or any(part in ('', '.', '..') for part in name.split('/')):
        raise ValueError('Unsafe archive path.')
    return name


def extract(source, destination):
    records = []
    total = 0
    seen = {}

    def record(raw, size, mode, directory, entry):
        nonlocal total
        name = clean_name(raw)
        if name is None:
            if directory:
                return
            raise ValueError('Invalid archive entry.')
        if name in seen:
            if directory and seen[name]:
                return
            raise ValueError('Duplicate archive path.')
        seen[name] = directory
        total += size
        if len(seen) > MAX_FILES or total > MAX_BYTES or size < 0:
            raise ValueError('Import exceeds 10,000 entries or 1 GiB.')
        records.append((name, size, mode, directory, entry))

    if zipfile.is_zipfile(source):
        archive = zipfile.ZipFile(source)
        for entry in archive.infolist():
            mode = entry.external_attr >> 16
            filetype = stat.S_IFMT(mode)
            if filetype not in (0, stat.S_IFREG, stat.S_IFDIR) or entry.flag_bits & 1:
                raise ValueError('Links, special files and encrypted entries are not allowed.')
            record(entry.filename, entry.file_size, mode, entry.is_dir(), entry)
        read = archive.open
    else:
        archive = tarfile.open(source, 'r:*')
        for entry in archive:
            if not (entry.isfile() or entry.isdir()) or getattr(entry, 'sparse', None):
                raise ValueError('Links and special files are not allowed.')
            record(entry.name, entry.size, entry.mode, entry.isdir(), entry)
        read = archive.extractfile
    try:
        # Validate every header and parent before writing any extracted file.
        for name in seen:
            parts = name.split('/')
            for i in range(1, len(parts)):
                if seen.get('/'.join(parts[:i])) is False:
                    raise ValueError('Archive file/directory conflict.')
        actual_total = 0
        for name, size, mode, directory, entry in records:
            target = destination / name
            if directory:
                target.mkdir(parents=True, exist_ok=True, mode=0o755)
                continue
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
            copied = 0
            with read(entry) as incoming, target.open('xb') as outgoing:
                while True:
                    chunk = incoming.read(65536)
                    if not chunk:
                        break
                    copied += len(chunk)
                    actual_total += len(chunk)
                    if copied > size or actual_total > MAX_BYTES:
                        raise ValueError('Expanded archive is too large.')
                    outgoing.write(chunk)
            if copied != size:
                raise ValueError('Truncated archive entry.')
            target.chmod(0o755 if mode & 0o111 else 0o644)
    finally:
        archive.close()


if __name__ == '__main__':
    try:
        destination = Path(sys.argv[2])
        if not destination.is_dir() or any(destination.iterdir()):
            raise ValueError('Extraction requires an empty staging directory.')
        extract(sys.argv[1], destination)
    except Exception as error:
        print(f'Import rejected: {error}', file=sys.stderr)
        sys.exit(1)
