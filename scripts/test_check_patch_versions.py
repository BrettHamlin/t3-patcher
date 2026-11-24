"""Tests for check_patch_versions.py against real git repositories. Run by the tests gate (scripts/check.py)."""
from pathlib import Path
import json
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_patch_versions import problems  # noqa: E402

IDENTITY = ['-c', 'user.name=test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false']


class PatchVersions(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.repo = Path(self.temporary.name)
        self.git('init', '--quiet', '--initial-branch=main')
        self.write('kept', version=1, diff='kept\n')
        self.write('bumped', version=2, diff='bumped\n')
        self.write('stale', version=3, diff='stale\n')
        self.write('relabelled', version=1, diff='same\n')
        self.write('renumbered', version=4, diff='same\n')
        self.write('gone', version=1, diff='gone\n')
        self.write('unversioned', version=None, diff='old\n')
        self.commit('base')
        self.git('checkout', '--quiet', '-b', 'feature')

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def git(self, *args: str) -> None:
        subprocess.run(['git', *IDENTITY, *args], cwd=self.repo, check=True, capture_output=True)

    def write(self, patch: str, version: int | None, diff: str, title: str = 'Title') -> None:
        folder = self.repo / 'patches' / patch
        folder.mkdir(parents=True, exist_ok=True)
        manifest = {'id': patch, 'title': title, 'summary': 'Summary'}
        if version is not None:
            manifest['version'] = version
        (folder / 'patch.json').write_text(json.dumps(manifest, indent=2) + '\n')
        (folder / 'changes.patch').write_text(diff)

    def commit(self, message: str) -> None:
        self.git('add', '-A')
        self.git('commit', '--quiet', '--allow-empty', '-m', message)

    def test_unchanged_patches_pass(self) -> None:
        self.commit('nothing')
        self.assertEqual(problems(self.repo, 'main'), [])

    def test_each_kind_of_change(self) -> None:
        self.write('bumped', version=3, diff='bumped twice\n')       # changed with a bump: fine
        self.write('stale', version=3, diff='stale, changed\n')      # changed without a bump
        self.write('relabelled', version=1, diff='same\n', title='New title')  # patch.json changed, no bump
        self.write('renumbered', version=5, diff='same\n')           # only the version changed: fine
        self.write('fresh', version=1, diff='new\n')                 # new: fine at 1
        self.write('unversioned', version=None, diff='new\n')        # no version is 1, same as before
        subprocess.run(['rm', '-r', str(self.repo / 'patches' / 'gone')], check=True)  # deleted: fine
        self.commit('changes')
        self.assertEqual(problems(self.repo, 'main'), [
            'relabelled: changed but version is still 1 (main has 1)',
            'stale: changed but version is still 3 (main has 3)',
            'unversioned: changed but version is still 1 (main has 1)',
        ])

    def test_a_new_patch_needs_a_version_from_1(self) -> None:
        self.write('fresh', version=0, diff='new\n')
        self.commit('new')
        self.assertEqual(problems(self.repo, 'main'), ['fresh: version must be a whole number from 1, not 0'])

    def test_the_base_name_drops_origin(self) -> None:
        self.git('update-ref', 'refs/remotes/origin/main', 'main')
        self.write('stale', version=2, diff='stale, changed\n')
        self.commit('lower')
        self.assertEqual(problems(self.repo, 'origin/main'), ['stale: changed but version is still 2 (main has 3)'])


if __name__ == '__main__':
    unittest.main()
