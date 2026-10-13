import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest

from jbd_bms.updater import Updater


def git(cwd, *args):
    env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@x", "GIT_COMMITTER_NAME": "t",
           "GIT_COMMITTER_EMAIL": "t@x"}
    r = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, env=env)
    if r.returncode != 0:
        raise RuntimeError(r.stderr)
    return r.stdout.strip()


class UpdaterTest(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        self.bare = self.tmp / "origin.git"
        git(self.tmp, "init", "--bare", "-b", "main", str(self.bare))
        # «разработчик» пушит изменения
        self.dev = self.tmp / "dev"
        git(self.tmp, "clone", str(self.bare), str(self.dev))
        git(self.dev, "checkout", "-b", "main")
        (self.dev / "jbd-bms-py").mkdir()
        (self.dev / "jbd-bms-py" / "requirements.txt").write_text("PySide6\n")
        (self.dev / "jbd-bms-py" / "app.py").write_text("v1\n")
        (self.dev / "other").mkdir()
        (self.dev / "other" / "x.txt").write_text("1\n")
        git(self.dev, "add", "-A")
        git(self.dev, "commit", "-m", "init")
        git(self.dev, "push", "-u", "origin", "main")
        # установленная копия программы
        self.inst = self.tmp / "inst"
        git(self.tmp, "clone", "-b", "main", str(self.bare), str(self.inst))
        self.app = self.inst / "jbd-bms-py"
        self.pip_calls = []

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def push(self, rel, text, msg="change"):
        p = self.dev / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
        git(self.dev, "add", "-A")
        git(self.dev, "commit", "-m", msg)
        git(self.dev, "push", "origin", "main")

    def pip(self, app_dir):
        self.pip_calls.append(str(app_dir))
        return 0, "ok"

    def updater(self):
        return Updater(self.app, pip_install=self.pip)

    def test_up_to_date(self):
        st = self.updater().check()
        self.assertEqual(st.phase, "idle")
        self.assertFalse(st.update_available)

    def test_new_commit_in_app_folder_detected_and_applied(self):
        self.push("jbd-bms-py/app.py", "v2\n", "app v2")
        u = self.updater()
        st = u.check()
        self.assertTrue(st.update_available)
        self.assertEqual(st.phase, "ready")
        st = u.apply()
        self.assertEqual(st.phase, "done")
        self.assertTrue(st.restart_required)
        self.assertEqual((self.app / "app.py").read_text(), "v2\n")
        self.assertEqual(self.pip_calls, [], "requirements не менялись — pip не нужен")

    def test_commit_outside_app_folder_is_not_an_update(self):
        self.push("other/x.txt", "2\n", "other")
        st = self.updater().check()
        self.assertFalse(st.update_available)
        self.assertEqual(st.phase, "idle")

    def test_requirements_change_runs_pip(self):
        self.push("jbd-bms-py/requirements.txt", "PySide6\npyserial\n", "deps")
        u = self.updater()
        u.check()
        st = u.apply()
        self.assertEqual(st.phase, "done")
        self.assertEqual(self.pip_calls, [str(self.app.resolve())])

    def test_local_changes_block_update(self):
        self.push("jbd-bms-py/app.py", "v2\n", "app v2")
        (self.app / "app.py").write_text("local edit\n")
        u = self.updater()
        u.check()
        st = u.apply()
        self.assertEqual(st.phase, "error")
        self.assertIn("локальные изменения", st.message)
        self.assertEqual((self.app / "app.py").read_text(), "local edit\n")

    def test_other_branch_blocks_update(self):
        self.push("jbd-bms-py/app.py", "v2\n", "app v2")
        git(self.inst, "checkout", "-b", "feature")
        st = self.updater().apply()
        self.assertEqual(st.phase, "error")
        self.assertIn("ветка «feature»", st.message)

    def test_diverged_history_refuses_ff(self):
        self.push("jbd-bms-py/app.py", "v2\n", "app v2")
        (self.inst / "local.txt").write_text("mine\n")
        git(self.inst, "add", "-A")
        git(self.inst, "commit", "-m", "local commit")
        st = self.updater().apply()
        self.assertEqual(st.phase, "error")
        self.assertIn("без слияния", st.message)

    def test_not_a_git_clone(self):
        plain = self.tmp / "plain"
        plain.mkdir()
        st = Updater(plain).check()
        self.assertEqual(st.phase, "unsupported")
        self.assertFalse(st.update_available)


if __name__ == "__main__":
    unittest.main()
